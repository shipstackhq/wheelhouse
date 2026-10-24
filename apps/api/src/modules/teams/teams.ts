import { DEFAULT_STATUS_DEFS } from "@wheelhouse/shared/status-roles";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "../../db";
import type { Actor } from "../../lib/access";
import { parseTeamIcon, parseTeamIconColor } from "./team-icon";
import { ServiceError } from "../../lib/service-error";
import { deleteBlock, resolveParent } from "./team-lifecycle";
import { assertWritable, audit, lockWorkspaceTeams, type Need, roleAllows, roleOnTeam, visibleTeamIds, workspaceRoleOf } from "./team-access";
import { Q, emit, isUuid } from "../../lib/service-core";

const { teams, statuses, events, projects } = schema;

// ───────────────────────── teams ─────────────────────────

/** The teams the actor can open: a person's own teams, or the teams an agent key is scoped to (ADR-23, WH-120). */
export async function listTeams(actor: Actor, opts: { includeRetired?: boolean } = {}) {
  const db = await getDb();
  const visible = await visibleTeamIds(db, actor);
  if (visible && !visible.length) return [];
  return db
    .select()
    .from(teams)
    .where(and(eq(teams.workspaceId, actor.workspaceId), visible ? inArray(teams.id, visible) : undefined, opts.includeRetired ? undefined : isNull(teams.retiredAt)))
    .orderBy(asc(teams.createdAt));
}

/** Finds a team of the actor's workspace by uuid or key, WITHOUT checking that the actor may open it. Only access code uses this. */
export async function findWorkspaceTeam(actor: Actor, ref: string, q?: Q) {
  const db = q ?? (await getDb());
  const [p] = await db
    .select()
    .from(teams)
    .where(
      and(
        eq(teams.workspaceId, actor.workspaceId),
        isUuid(ref) ? eq(teams.id, ref) : eq(sql`upper(${teams.key})`, ref.toUpperCase()),
      ),
    );
  return p;
}

/**
 * Accepts a team uuid or its key (e.g. "WH"). A team of another workspace and a team the actor is not a member of both
 * answer not_found, so its existence does not leak; a member whose role is too low for `need` gets forbidden (ADR-23).
 */
export async function requireTeam(actor: Actor, ref: string, need: Need = "read", q?: Q) {
  const db = q ?? (await getDb());
  const p = await findWorkspaceTeam(actor, ref, db);
  const role = p ? await roleOnTeam(db, actor, p.id) : null;
  if (!p || !role) throw new ServiceError("not_found", `Team ${ref} not found`);
  if (!roleAllows(role, need)) throw new ServiceError("forbidden", need === "admin" ? "Only a team admin can do that" : "Your role on this team is read only");
  // The one check behind every write path: a retired team can be read, never changed (WH-128).
  if (need === "edit") assertWritable(p);
  return p;
}

/** Rename a team and/or change its description. Team admins only; the key never changes (issues are named after it). */
export async function updateTeam(actor: Actor, ref: string, input: { name?: string; description?: string; icon?: unknown; iconColor?: unknown }) {
  if (actor.kind !== "human") throw new ServiceError("forbidden", "Only teammates can edit a team's settings");
  const db = await getDb();
  const p = await requireTeam(actor, ref, "admin", db);
  const name = input.name === undefined ? p.name : input.name.trim();
  if (!name) throw new ServiceError("invalid", "Team name is required");
  const description = input.description === undefined ? p.description : input.description.trim();
  const icon = parseTeamIcon(input.icon);
  const iconColor = parseTeamIconColor(input.iconColor);
  const next = { name, description, icon: icon === undefined ? p.icon : icon, iconColor: iconColor === undefined ? p.iconColor : iconColor };
  if (next.name === p.name && next.description === p.description && next.icon === p.icon && next.iconColor === p.iconColor) return p;
  return db.transaction(async (tx) => {
    const [row] = await tx.update(teams).set(next).where(eq(teams.id, p.id)).returning();
    await audit(tx, actor, { action: "team.updated", targetType: "team", targetId: p.id, teamId: p.id, before: { name: p.name, icon: p.icon, iconColor: p.iconColor }, after: { name, icon: next.icon, iconColor: next.iconColor } });
    await emit(tx, actor, p.id, { type: "team.updated", entity: "team", entityId: p.id, summary: `updated the settings of team ${row.name}` });
    return row;
  });
}

/** Delete a team and everything in it (issues, map, flows, drafts, sessions, activity). Teammates only. */
export async function deleteTeam(actor: Actor, ref: string) {
  if (actor.kind !== "human") throw new ServiceError("forbidden", "Only teammates can delete a team");
  const db = await getDb();
  const found = await requireTeam(actor, ref, "admin");
  const p = await db.transaction(async (tx) => {
    // Lock the workspace's teams, then count: two admins deleting the last two teams at once cannot both succeed.
    await lockWorkspaceTeams(tx, found.workspaceId);
    const [p] = await tx.select().from(teams).where(eq(teams.id, found.id));
    if (!p) throw new ServiceError("not_found", `Team ${ref} not found`);
    // The last active team stays, a team that leads a live project waits until someone else leads it, and child teams go or move first.
    const why = await deleteBlock(tx, actor, p);
    if (why) throw new ServiceError("conflict", why);
    // A deleted project the team led goes for good with it.
    const led = await tx.select({ id: projects.id }).from(projects).where(eq(projects.leadTeamId, p.id));
    if (led.length) await tx.delete(projects).where(inArray(projects.id, led.map((x) => x.id)));
    await audit(tx, actor, { action: "team.deleted", targetType: "team", targetId: p.id, teamId: p.id, before: { key: p.key, name: p.name, retired: !!p.retiredAt } });
    // events has no foreign key to teams, so clear it explicitly; everything else cascades.
    await tx.delete(events).where(eq(events.teamId, p.id));
    await tx.delete(teams).where(eq(teams.id, p.id));
    return p;
  });
  return { ok: true, deleted: p.key };
}

export async function createTeam(actor: Actor, input: { name: string; key?: string; description?: string; parent?: string | null }) {
  const db = await getDb();
  const name = input.name.trim();
  if (!name) throw new ServiceError("invalid", "Team name is required");
  // Workspace Viewers and Guests cannot start teams (ADR-23); agent keys can still create them.
  if (actor.kind === "human") {
    const ws = await workspaceRoleOf(db, actor.workspaceId, actor.id);
    if (ws !== "owner" && ws !== "admin" && ws !== "member") throw new ServiceError("forbidden", "Your workspace role cannot create teams");
  }
  const key = (input.key || name.replace(/[^a-zA-Z]/g, "").slice(0, 3) || "PRJ").toUpperCase().slice(0, 6);
  const existing = await db
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.workspaceId, actor.workspaceId), eq(teams.key, key)));
  if (existing.length) throw new ServiceError("conflict", `Team key ${key} already in use`);

  return db.transaction(async (tx) => {
    // A parent must be a team of this workspace that the creator can open; it grants nothing in either direction.
    const parent = input.parent ? await resolveParent(tx, actor, null, input.parent) : null;
    const [p] = await tx
      .insert(teams)
      .values({ workspaceId: actor.workspaceId, name, key, description: input.description ?? "", parentId: parent?.id ?? null })
      .returning();
    await tx.insert(statuses).values(DEFAULT_STATUS_DEFS.map((c, i) => ({ teamId: p.id, workspaceId: p.workspaceId, name: c.name, role: c.role, isDefault: true, position: i + 1 })));
    // The creator becomes the team's first admin: without a row here nobody could open the team they just made.
    if (actor.kind === "human") {
      await tx.insert(schema.teamMembers).values({ teamId: p.id, userId: actor.id, workspaceId: actor.workspaceId, role: "admin", addedBy: actor.id });
      await audit(tx, actor, { action: "team.created", targetType: "team", targetId: p.id, teamId: p.id, after: { key: p.key, creatorRole: "admin", ...(parent ? { parentKey: parent.key } : {}) } });
    } else if (!actor.system) {
      // A key that makes a team is scoped to it, or it could not open what it just made (WH-120).
      await tx.insert(schema.apiKeyTeams).values({ apiKeyId: actor.id, teamId: p.id, workspaceId: p.workspaceId });
    }
    await emit(tx, actor, p.id, { type: "team.created", entity: "team", entityId: p.id, summary: `created team ${p.name}` });
    return p;
  });
}
