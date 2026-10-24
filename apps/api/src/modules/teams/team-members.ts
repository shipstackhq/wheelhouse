import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "../../db";
import type { TeamRole, WorkspaceRole } from "../../db/schema";
import type { Actor } from "../../common/actor";
import { audit, leaveBlock, lockWorkspaceTeams, teamRoleMap, roleOnTeam, workspaceRoleOf } from "./team-access";
import { canManagePeople } from "../../common/roles";
import { isUuid } from "../../common/uuid";
import { emit } from "../../platform/events/emit";
import { findWorkspaceTeam, requireTeam, listTeams } from "./teams";
import { ServiceError } from "../../common/service-error";

/**
 * Who is in a team and how they got there (ADR-23). Everything here is for people: an agent key cannot add or remove members.
 * Each change is checked against the caller's role, keeps at least one admin on the team, and writes an audit line.
 */

const { teamMembers: pm, memberships, users } = schema;

/**
 * The caller's teams, each with the caller's own role in it, in the order the person keeps them (see `setTeamOrder`): the ones they
 * have placed first, in their order, then any they have not, oldest first. An agent key or the system gets creation order.
 */
export async function listTeamsWithRole(actor: Actor) {
  const db = await getDb();
  // Retired teams come back too, flagged `retired`, so the sidebar can group them apart from the active ones.
  const [teams, roles] = await Promise.all([listTeams(actor, { includeRetired: true }), teamRoleMap(db, actor)]);
  const placed = new Map<string, number>();
  if (actor.kind === "human" && !actor.system) {
    const rows = await db.select({ teamId: pm.teamId, position: pm.position }).from(pm).where(and(eq(pm.userId, actor.id), eq(pm.workspaceId, actor.workspaceId)));
    for (const r of rows) if (r.position !== null) placed.set(r.teamId, r.position);
  }
  const rank = (id: string) => placed.get(id) ?? Number.POSITIVE_INFINITY;
  return teams
    .map((p) => ({ ...p, role: (roles?.get(p.id) ?? "editor") as TeamRole, retired: !!p.retiredAt }))
    .sort((a, b) => (rank(a.id) === rank(b.id) ? a.createdAt.getTime() - b.createdAt.getTime() : rank(a.id) < rank(b.id) ? -1 : 1));
}

/**
 * Remember the order the person wants their teams in: `keys` first to last. It is theirs alone (their own `team_members` rows), so it
 * changes nothing for anyone else. A key that is not one of their teams is ignored, and a team left out keeps its place after the rest.
 */
export async function setTeamOrder(actor: Actor, keys: unknown) {
  people(actor);
  if (!Array.isArray(keys) || keys.length > 500 || keys.some((k) => typeof k !== "string")) {
    throw new ServiceError("invalid", "keys must be a list of team keys", { fields: { keys: "a list of team keys" } });
  }
  const db = await getDb();
  const mine = await listTeams(actor, { includeRetired: true });
  const byKey = new Map(mine.map((t) => [t.key.toUpperCase(), t.id]));
  const ids = [...new Set((keys as string[]).map((k) => byKey.get(k.toUpperCase())).filter((x): x is string => !!x))];
  await db.transaction(async (tx) => {
    for (const [i, teamId] of ids.entries()) {
      await tx.update(pm).set({ position: (i + 1) * 1000 }).where(and(eq(pm.teamId, teamId), eq(pm.userId, actor.id), eq(pm.workspaceId, actor.workspaceId)));
    }
  });
  return { ok: true as const, placed: ids.length };
}

export type TeamMemberView = { userId: string; name: string; email: string; role: TeamRole; workspaceRole: WorkspaceRole; addedAt: Date };

function people(actor: Actor) {
  if (actor.kind !== "human" || actor.system) throw new ServiceError("forbidden", "Only people can manage who is in a team");
}

const isTeamRole = (v: unknown): v is TeamRole => typeof v === "string" && (schema.TEAM_ROLES as readonly string[]).includes(v);

/** The team's members. Any member can see who else is in it. */
export async function listTeamMembers(actor: Actor, teamRef: string) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef);
  const rows = await db
    .select({ userId: users.id, name: users.name, email: users.email, role: pm.role, workspaceRole: memberships.role, addedAt: pm.createdAt })
    .from(pm)
    .innerJoin(users, eq(users.id, pm.userId))
    .innerJoin(memberships, and(eq(memberships.userId, pm.userId), eq(memberships.workspaceId, pm.workspaceId)))
    .where(eq(pm.teamId, team.id))
    .orderBy(pm.createdAt);
  return { team: { id: team.id, key: team.key, name: team.name }, myRole: await roleOnTeam(db, actor, team.id), members: rows as TeamMemberView[] };
}

/** Workspace members who are not in the team yet, for the "add someone" list. Team admins only. */
export async function listAddableMembers(actor: Actor, teamRef: string) {
  people(actor);
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "admin");
  const rows = await db
    .select({ userId: users.id, name: users.name, email: users.email, workspaceRole: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.workspaceId, actor.workspaceId),
        sql`not exists (select 1 from ${pm} where ${pm.teamId} = ${team.id} and ${pm.userId} = ${memberships.userId})`,
      ),
    )
    .orderBy(users.name);
  return rows;
}

async function adminCount(q: Parameters<typeof audit>[0], teamId: string) {
  const [r] = await q.select({ n: sql<number>`count(*)::int` }).from(pm).where(and(eq(pm.teamId, teamId), eq(pm.role, "admin")));
  return Number(r.n);
}

/** Add a workspace member to the team. Team admins only; the person must already be in the workspace. */
export async function addTeamMember(actor: Actor, teamRef: string, input: { userId: string; role: unknown }) {
  people(actor);
  if (!isTeamRole(input.role)) throw new ServiceError("invalid", "Choose a team role: admin, editor or viewer");
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "admin");
  if (!isUuid(input.userId)) throw new ServiceError("not_found", "That person is not in this workspace");
  const ws = await workspaceRoleOf(db, actor.workspaceId, input.userId);
  if (!ws) throw new ServiceError("not_found", "That person is not in this workspace");
  const role = input.role;
  return db.transaction(async (tx) => {
    const [dup] = await tx.select({ userId: pm.userId }).from(pm).where(and(eq(pm.teamId, team.id), eq(pm.userId, input.userId)));
    if (dup) throw new ServiceError("conflict", "They are already in this team");
    await tx.insert(pm).values({ teamId: team.id, userId: input.userId, workspaceId: actor.workspaceId, role, addedBy: actor.id });
    await audit(tx, actor, { action: "team.member_added", targetType: "user", targetId: input.userId, teamId: team.id, after: { role } });
    return { userId: input.userId, role };
  });
}

/** Change someone's role in the team. Team admins only; the last admin cannot be demoted. */
export async function setTeamMemberRole(actor: Actor, teamRef: string, userId: string, roleIn: unknown) {
  people(actor);
  if (!isTeamRole(roleIn)) throw new ServiceError("invalid", "Choose a team role: admin, editor or viewer");
  const role = roleIn;
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "admin");
  if (!isUuid(userId)) throw new ServiceError("not_found", "They are not in this team");
  return db.transaction(async (tx) => {
    const [cur] = await tx.select({ role: pm.role }).from(pm).where(and(eq(pm.teamId, team.id), eq(pm.userId, userId)));
    if (!cur) throw new ServiceError("not_found", "They are not in this team");
    if (cur.role === role) return { userId, role };
    if (cur.role === "admin" && (await adminCount(tx, team.id)) <= 1) throw new ServiceError("conflict", "A team needs at least one admin. Name another admin first.");
    await tx.update(pm).set({ role }).where(and(eq(pm.teamId, team.id), eq(pm.userId, userId)));
    await audit(tx, actor, { action: "team.member_role_changed", targetType: "user", targetId: userId, teamId: team.id, before: { role: cur.role }, after: { role } });
    return { userId, role };
  });
}

/** Remove someone from the team, or leave it yourself. Team admins only (anyone may leave); the last admin cannot go. */
export async function removeTeamMember(actor: Actor, teamRef: string, userId: string) {
  people(actor);
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, userId === actor.id ? "read" : "admin");
  if (!isUuid(userId)) throw new ServiceError("not_found", "They are not in this team");
  return db.transaction(async (tx) => {
    // Leaving yourself also keeps you on one active team; the lock makes two leaves at once check one after the other.
    if (userId === actor.id) await lockWorkspaceTeams(tx, team.workspaceId);
    const [cur] = await tx.select({ role: pm.role }).from(pm).where(and(eq(pm.teamId, team.id), eq(pm.userId, userId)));
    if (!cur) throw new ServiceError("not_found", "They are not in this team");
    if (userId === actor.id) {
      const [fresh] = await tx.select().from(schema.teams).where(eq(schema.teams.id, team.id));
      const why = await leaveBlock(tx, fresh, userId);
      if (why) throw new ServiceError("conflict", why);
    } else if (cur.role === "admin" && (await adminCount(tx, team.id)) <= 1) throw new ServiceError("conflict", "A team needs at least one admin. Name another admin first.");
    await tx.delete(pm).where(and(eq(pm.teamId, team.id), eq(pm.userId, userId)));
    await audit(tx, actor, { action: userId === actor.id ? "team.member_left" : "team.member_removed", targetType: "user", targetId: userId, teamId: team.id, before: { role: cur.role } });
    return { ok: true as const };
  });
}

export type WorkspaceTeamView = { id: string; key: string; name: string; admins: string[]; memberCount: number; isMember: boolean };

/**
 * Every team of the workspace by name, with who administers it and whether you are in it: the list an owner or admin
 * uses to find a team to join. Nothing inside a team is visible from here. Owners and admins only.
 */
export async function listWorkspaceTeams(actor: Actor): Promise<WorkspaceTeamView[]> {
  people(actor);
  const db = await getDb();
  const ws = await workspaceRoleOf(db, actor.workspaceId, actor.id);
  if (!ws || !canManagePeople(ws)) throw new ServiceError("forbidden", "Only workspace owners and admins can see every team");
  const ps = await db.select().from(schema.teams).where(eq(schema.teams.workspaceId, actor.workspaceId)).orderBy(schema.teams.createdAt);
  const rows = await db
    .select({ teamId: pm.teamId, userId: pm.userId, role: pm.role, name: users.name })
    .from(pm)
    .innerJoin(users, eq(users.id, pm.userId))
    .where(eq(pm.workspaceId, actor.workspaceId));
  return ps.map((p) => {
    const mine = rows.filter((r) => r.teamId === p.id);
    return { id: p.id, key: p.key, name: p.name, admins: mine.filter((r) => r.role === "admin").map((r) => r.name), memberCount: mine.length, isMember: mine.some((r) => r.userId === actor.id) };
  });
}

/**
 * An owner or admin of the workspace joins a team as its admin, for example to recover one whose admins left. Never silent:
 * it writes an audit line and a line in the team's own activity, so its members see who came in and when.
 */
export async function joinTeamAsWorkspaceAdmin(actor: Actor, teamRef: string) {
  people(actor);
  const db = await getDb();
  const ws = await workspaceRoleOf(db, actor.workspaceId, actor.id);
  if (!ws || !canManagePeople(ws)) throw new ServiceError("forbidden", "Only workspace owners and admins can join a team");
  const team = await findWorkspaceTeam(actor, teamRef, db);
  if (!team) throw new ServiceError("not_found", `Team ${teamRef} not found`);
  return db.transaction(async (tx) => {
    const [dup] = await tx.select({ userId: pm.userId }).from(pm).where(and(eq(pm.teamId, team.id), eq(pm.userId, actor.id)));
    if (dup) throw new ServiceError("conflict", "You are already in this team");
    await tx.insert(pm).values({ teamId: team.id, userId: actor.id, workspaceId: actor.workspaceId, role: "admin", addedBy: actor.id });
    await audit(tx, actor, { action: "team.admin_joined", targetType: "user", targetId: actor.id, teamId: team.id, after: { role: "admin", workspaceRole: ws } });
    await emit(tx, actor, team.id, { type: "team.admin_joined", entity: "team", entityId: team.id, summary: `${actor.name} (workspace ${ws}) joined ${team.key} as admin` });
    return { team: { id: team.id, key: team.key, name: team.name } };
  });
}

export type AuditView = { seq: number; actorName: string; action: string; targetType: string; targetId: string | null; teamKey: string | null; before: unknown; after: unknown; createdAt: Date };

/** The access audit log, newest first. Owners and admins only; `teamRef` narrows it to one team they can name. */
export async function listAudit(actor: Actor, opts: { teamRef?: string; limit?: number } = {}): Promise<AuditView[]> {
  people(actor);
  const db = await getDb();
  const ws = await workspaceRoleOf(db, actor.workspaceId, actor.id);
  if (!ws || !canManagePeople(ws)) throw new ServiceError("forbidden", "Only workspace owners and admins can read the audit log");
  const a = schema.auditEvents;
  let teamId: string | undefined;
  if (opts.teamRef) {
    const p = await findWorkspaceTeam(actor, opts.teamRef, db);
    if (!p) throw new ServiceError("not_found", `Team ${opts.teamRef} not found`);
    teamId = p.id;
  }
  const rows = await db
    .select({ a, key: schema.teams.key })
    .from(a)
    .leftJoin(schema.teams, eq(schema.teams.id, a.teamId))
    .where(and(eq(a.workspaceId, actor.workspaceId), teamId ? eq(a.teamId, teamId) : undefined))
    .orderBy(desc(a.seq))
    .limit(Number.isFinite(opts.limit) ? Math.min(Math.max(Math.trunc(opts.limit!), 1), 500) : 100);
  return rows.map(({ a: r, key }) => ({ seq: r.seq, actorName: r.actorName, action: r.action, targetType: r.targetType, targetId: r.targetId, teamKey: key, before: r.before, after: r.after, createdAt: r.createdAt }));
}
