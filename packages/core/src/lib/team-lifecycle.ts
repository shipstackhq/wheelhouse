import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { getDb, schema } from "../db";
import type { TeamRole } from "../db/schema";
import type { Actor } from "./access";
import { audit, leaveBlock, lockWorkspaceTeams, roleOnTeam, visibleTeamIds } from "./team-access";
import { emit, findWorkspaceTeam, requireTeam, type Q } from "./service";
import { ServiceError } from "./service-error";

/**
 * A team's lifecycle (active → retired → deleted) and its place in a hierarchy (WH-128). The guards here are shared by the actions
 * (which run them inside the transaction, after locking the workspace's teams) and by the team settings read (which shows the same
 * reason beside a disabled button), so what the screen says is what the API would answer. A parent grants no access (ADR-23).
 */

const { teams, projects } = schema;
type TeamRow = typeof teams.$inferSelect;

export type Guard = { allowed: boolean; reason: string | null };
const guard = (reason: string | null): Guard => ({ allowed: !reason, reason });

function people(actor: Actor, what: string) {
  if (actor.kind !== "human" || actor.system) throw new ServiceError("forbidden", `Only people can ${what}`);
}

/** How many other active teams the workspace has. */
async function otherActiveTeams(q: Q, team: TeamRow) {
  const [r] = await q.select({ n: sql<number>`count(*)::int` }).from(teams).where(and(eq(teams.workspaceId, team.workspaceId), isNull(teams.retiredAt), ne(teams.id, team.id)));
  return Number(r.n);
}

/** Live projects the team leads, as a message; null when it leads none. */
async function leadsProjectBlock(q: Q, team: TeamRow) {
  const led = await q.select({ name: projects.name }).from(projects).where(and(eq(projects.leadTeamId, team.id), isNull(projects.deletedAt)));
  if (!led.length) return null;
  return `${team.name} leads ${led.map((x) => `"${x.name}"`).join(", ")}. Make another team the lead of ${led.length === 1 ? "that project" : "those projects"} first.`;
}

/** Child teams in the way, as a message naming those the actor can open and counting those they cannot. A retired child does not block a retire, only a delete. */
async function childrenBlock(q: Q, actor: Actor, team: TeamRow, action: "retire" | "delete") {
  const kids = await q
    .select({ id: teams.id, key: teams.key, name: teams.name })
    .from(teams)
    .where(and(eq(teams.workspaceId, team.workspaceId), eq(teams.parentId, team.id), action === "retire" ? isNull(teams.retiredAt) : undefined))
    .orderBy(asc(teams.name));
  if (!kids.length) return null;
  const seen = new Set(await visibleTeamIds(q, actor));
  const mine = kids.filter((k) => seen.has(k.id));
  const hidden = kids.length - mine.length;
  const names = mine.map((k) => `${k.name} (${k.key})`).join(", ");
  const list = mine.length ? (hidden ? `${names} and ${hidden} you cannot see` : names) : `${hidden} you cannot see`;
  return `${team.name} has child teams: ${list}. ${action === "retire" ? "Re-parent, retire or delete" : "Re-parent or delete"} them first.`;
}

/** Why the team cannot be retired right now, or null. Run inside the transaction that retires it. */
export async function retireBlock(q: Q, actor: Actor, team: TeamRow): Promise<string | null> {
  if (team.retiredAt) return `${team.name} is already retired.`;
  if (!(await otherActiveTeams(q, team))) return "This is the last active team in the workspace, so it cannot be retired.";
  return (await leadsProjectBlock(q, team)) ?? (await childrenBlock(q, actor, team, "retire"));
}

/** Why the team cannot be deleted right now, or null. A retired team is not limited by the last-active-team rule. */
export async function deleteBlock(q: Q, actor: Actor, team: TeamRow): Promise<string | null> {
  if (!team.retiredAt && !(await otherActiveTeams(q, team))) return "This is the last active team in the workspace, so it cannot be deleted.";
  return (await leadsProjectBlock(q, team)) ?? (await childrenBlock(q, actor, team, "delete"));
}

/** Retire a team: read only, hidden from the main sidebar, kept with its data and members. Team admins only. */
export async function retireTeam(actor: Actor, ref: string) {
  people(actor, "retire a team");
  const db = await getDb();
  const found = await requireTeam(actor, ref, "admin", db);
  return db.transaction(async (tx) => {
    await lockWorkspaceTeams(tx, found.workspaceId);
    const [team] = await tx.select().from(teams).where(eq(teams.id, found.id));
    if (!team) throw new ServiceError("not_found", `Team ${ref} not found`);
    const why = await retireBlock(tx, actor, team);
    if (why) throw new ServiceError("conflict", why);
    const [row] = await tx.update(teams).set({ retiredAt: new Date(), retiredBy: actor.id }).where(eq(teams.id, team.id)).returning();
    await audit(tx, actor, { action: "team.retired", targetType: "team", targetId: team.id, teamId: team.id, after: { key: team.key } });
    await emit(tx, actor, team.id, { type: "team.retired", entity: "team", entityId: team.id, summary: `retired team ${team.name}` });
    return row;
  });
}

/** Bring a retired team back, with everything intact. Team admins only (a workspace owner or admin joins as admin first). */
export async function restoreTeam(actor: Actor, ref: string) {
  people(actor, "restore a team");
  const db = await getDb();
  const found = await requireTeam(actor, ref, "admin", db);
  return db.transaction(async (tx) => {
    await lockWorkspaceTeams(tx, found.workspaceId);
    const [team] = await tx.select().from(teams).where(eq(teams.id, found.id));
    if (!team) throw new ServiceError("not_found", `Team ${ref} not found`);
    if (!team.retiredAt) throw new ServiceError("conflict", `${team.name} is not retired.`);
    const [row] = await tx.update(teams).set({ retiredAt: null, retiredBy: null }).where(eq(teams.id, team.id)).returning();
    await audit(tx, actor, { action: "team.restored", targetType: "team", targetId: team.id, teamId: team.id, after: { key: team.key } });
    await emit(tx, actor, team.id, { type: "team.restored", entity: "team", entityId: team.id, summary: `restored team ${team.name}` });
    return row;
  });
}

/**
 * Check a candidate parent for a team (`team` is null while one is being created): in the same workspace, one the actor can open, and
 * not the team itself or one of its descendants. A parent of another workspace or one the actor cannot open answers not_found.
 */
export async function resolveParent(q: Q, actor: Actor, team: TeamRow | null, parentRef: string): Promise<TeamRow> {
  const parent = await findWorkspaceTeam(actor, parentRef, q);
  if (!parent || !(await roleOnTeam(q, actor, parent.id))) throw new ServiceError("not_found", `Team ${parentRef} not found`);
  if (team) {
    if (parent.id === team.id) throw new ServiceError("invalid", "A team cannot be its own parent");
    // Walk up from the new parent: meeting the team means it would become its own ancestor.
    const seen = new Set<string>();
    for (let at: string | null = parent.id; at && !seen.has(at); ) {
      if (at === team.id) throw new ServiceError("invalid", `${parent.name} is inside ${team.name}, so it cannot be its parent`);
      seen.add(at);
      const [up]: { parentId: string | null }[] = await q.select({ parentId: teams.parentId }).from(teams).where(eq(teams.id, at));
      at = up?.parentId ?? null;
    }
  }
  return parent;
}

/** Set, change or clear (`null`) a team's parent. Admin of the team, who must also be able to open the new parent. */
export async function setTeamParent(actor: Actor, ref: string, parentRef: string | null) {
  people(actor, "change a team's parent");
  const db = await getDb();
  const found = await requireTeam(actor, ref, "admin", db);
  return db.transaction(async (tx) => {
    await lockWorkspaceTeams(tx, found.workspaceId);
    const [team] = await tx.select().from(teams).where(eq(teams.id, found.id));
    const parent = parentRef ? await resolveParent(tx, actor, team, parentRef) : null;
    if ((parent?.id ?? null) === team.parentId) return team;
    const [before] = team.parentId ? await tx.select({ id: teams.id, key: teams.key }).from(teams).where(eq(teams.id, team.parentId)) : [];
    const [row] = await tx.update(teams).set({ parentId: parent?.id ?? null }).where(eq(teams.id, team.id)).returning();
    await audit(tx, actor, {
      action: "team.parent_changed",
      targetType: "team",
      targetId: team.id,
      teamId: team.id,
      before: { parentId: before?.id ?? null, parentKey: before?.key ?? null },
      after: { parentId: parent?.id ?? null, parentKey: parent?.key ?? null },
    });
    await emit(tx, actor, team.id, { type: "team.parent_changed", entity: "team", entityId: team.id, summary: parent ? `moved team ${team.name} under ${parent.name}` : `made team ${team.name} a top-level team` });
    return row;
  });
}

export type TeamSettings = {
  team: { id: string; key: string; name: string; retired: boolean; retiredAt: Date | null };
  myRole: TeamRole;
  /** The parent, when the person can open it; a parent they cannot open is not named. */
  parent: { key: string; name: string; retired: boolean } | null;
  /** Child teams the person can open, and how many more they cannot. */
  children: { key: string; name: string; retired: boolean }[];
  hiddenChildren: number;
  canLeave: Guard;
  canRetire: Guard;
  canDelete: Guard;
};

/** The team settings read: the team's place in the hierarchy and, for each Danger zone action, whether it is allowed and why not. */
export async function getTeamSettings(actor: Actor, ref: string): Promise<TeamSettings> {
  people(actor, "open team settings");
  const db = await getDb();
  const team = await requireTeam(actor, ref, "read", db);
  const role = (await roleOnTeam(db, actor, team.id)) as TeamRole;
  const seen = new Set(await visibleTeamIds(db, actor));
  const kids = await db.select().from(teams).where(and(eq(teams.workspaceId, team.workspaceId), eq(teams.parentId, team.id))).orderBy(asc(teams.name));
  const [parent] = team.parentId && seen.has(team.parentId) ? await db.select().from(teams).where(eq(teams.id, team.parentId)) : [];
  const view = (t: TeamRow) => ({ key: t.key, name: t.name, retired: !!t.retiredAt });
  const admin = role === "admin";
  return {
    team: { id: team.id, key: team.key, name: team.name, retired: !!team.retiredAt, retiredAt: team.retiredAt },
    myRole: role,
    parent: parent ? view(parent) : null,
    children: kids.filter((k) => seen.has(k.id)).map(view),
    hiddenChildren: kids.filter((k) => !seen.has(k.id)).length,
    canLeave: guard(await leaveBlock(db, team, actor.id)),
    canRetire: guard(admin ? await retireBlock(db, actor, team) : "Only a team admin can retire a team"),
    canDelete: guard(admin ? await deleteBlock(db, actor, team) : "Only a team admin can delete a team"),
  };
}

/** The teams the person can open that could be this team's parent: not itself and not one of its descendants. `ref` is omitted while a team is being created. */
export async function parentCandidates(actor: Actor, ref?: string) {
  people(actor, "pick a parent team");
  const db = await getDb();
  const team = ref ? await requireTeam(actor, ref, "admin", db) : null;
  const ids = await visibleTeamIds(db, actor);
  if (!ids.length) return [];
  const rows = await db.select().from(teams).where(and(eq(teams.workspaceId, actor.workspaceId), inArray(teams.id, ids))).orderBy(asc(teams.name));
  const all = await db.select({ id: teams.id, parentId: teams.parentId }).from(teams).where(eq(teams.workspaceId, actor.workspaceId));
  const up = new Map(all.map((t) => [t.id, t.parentId]));
  const inside = (id: string) => {
    for (let at: string | null | undefined = id, n = 0; at && n < 1000; at = up.get(at), n++) if (at === team!.id) return true;
    return false;
  };
  return rows.filter((t) => !team || !inside(t.id)).map((t) => ({ id: t.id, key: t.key, name: t.name, retired: !!t.retiredAt }));
}
