import { and, eq, isNull, sql } from "drizzle-orm";
import { schema } from "../../db";
import type { TeamRole, WorkspaceRole } from "../../db/schema";
import type { Actor } from "../../common/actor";
import type { Q } from "../../platform/database/transaction";
import { effectiveRole } from "../../common/roles";

/**
 * Who can open a team (ADR-23). A team is reachable only through a row in `team_members`; the workspace role never
 * opens one by itself, not even an owner's. This file holds the rule and the audit trail; `requireTeam` and `resolveIssue` in
 * service.ts apply it, which is what puts every read and write path behind it.
 *
 * Agent keys and system actors (a GitHub webhook) are not people and have no row here. A key reaches the teams it is scoped to in `api_key_teams`
 * (as an editor, never an admin) and a system actor the one team it was made for; any other team answers exactly as it does for a stranger (WH-120).
 */

/** The teams a key or system actor is scoped to: the key's rows in `api_key_teams`, or the one team of a system actor. */
async function scopedTeamIds(q: Q, actor: Actor): Promise<string[]> {
  if (actor.system) return actor.teamId ? [actor.teamId] : [];
  const { apiKeyTeams } = schema;
  const rows = await q
    .select({ id: apiKeyTeams.teamId })
    .from(apiKeyTeams)
    .where(and(eq(apiKeyTeams.apiKeyId, actor.id), eq(apiKeyTeams.workspaceId, actor.workspaceId)));
  return rows.map((r) => r.id);
}

/** The actor's role on one team, or null when they cannot open it. The membership join also drops anyone removed from the workspace. */
export async function roleOnTeam(q: Q, actor: Actor, teamId: string): Promise<TeamRole | null> {
  if (actor.kind === "agent" || actor.system) {
    if (actor.system) return actor.teamId === teamId ? "editor" : null;
    const { apiKeyTeams } = schema;
    const [row] = await q
      .select({ id: apiKeyTeams.teamId })
      .from(apiKeyTeams)
      .where(and(eq(apiKeyTeams.apiKeyId, actor.id), eq(apiKeyTeams.teamId, teamId), eq(apiKeyTeams.workspaceId, actor.workspaceId)));
    return row ? "editor" : null;
  }
  const { teamMembers: pm, memberships } = schema;
  const [row] = await q
    .select({ role: pm.role, workspaceRole: memberships.role })
    .from(pm)
    .innerJoin(memberships, and(eq(memberships.userId, pm.userId), eq(memberships.workspaceId, pm.workspaceId)))
    .where(and(eq(pm.teamId, teamId), eq(pm.userId, actor.id), eq(pm.workspaceId, actor.workspaceId)));
  return row ? effectiveRole(row.role, row.workspaceRole) : null;
}

/** Ids of the workspace's teams the actor can open. Used by every cross-team query. */
export async function visibleTeamIds(q: Q, actor: Actor): Promise<string[]> {
  if (actor.kind === "agent" || actor.system) return scopedTeamIds(q, actor);
  const { teamMembers: pm, memberships } = schema;
  const rows = await q
    .select({ id: pm.teamId, workspaceRole: memberships.role })
    .from(pm)
    .innerJoin(memberships, and(eq(memberships.userId, pm.userId), eq(memberships.workspaceId, pm.workspaceId)))
    .where(and(eq(pm.userId, actor.id), eq(pm.workspaceId, actor.workspaceId)));
  return rows.map((r) => r.id);
}

/** The actor's role in each team they can open, by team id (editor in each team of a key or system actor). */
export async function teamRoleMap(q: Q, actor: Actor): Promise<Map<string, TeamRole>> {
  if (actor.kind === "agent" || actor.system) return new Map((await scopedTeamIds(q, actor)).map((id) => [id, "editor" as const]));
  const { teamMembers: pm, memberships } = schema;
  const rows = await q
    .select({ id: pm.teamId, role: pm.role, workspaceRole: memberships.role })
    .from(pm)
    .innerJoin(memberships, and(eq(memberships.userId, pm.userId), eq(memberships.workspaceId, pm.workspaceId)))
    .where(and(eq(pm.userId, actor.id), eq(pm.workspaceId, actor.workspaceId)));
  return new Map(rows.flatMap((r) => { const e = effectiveRole(r.role, r.workspaceRole); return e ? [[r.id, e] as const] : []; }));
}

/** The person's role in the workspace, or null if they are not in it. */
export async function workspaceRoleOf(q: Q, workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
  const [m] = await q
    .select({ role: schema.memberships.role })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.workspaceId, workspaceId), eq(schema.memberships.userId, userId)));
  return m?.role ?? null;
}

/** Append a line to the access audit log (never updated, never deleted). */
export async function audit(
  q: Q,
  actor: Actor,
  e: { action: string; targetType: "user" | "team" | "membership"; targetId?: string | null; teamId?: string | null; before?: Record<string, unknown> | null; after?: Record<string, unknown> | null },
) {
  await q.insert(schema.auditEvents).values({
    workspaceId: actor.workspaceId,
    teamId: e.teamId ?? null,
    actorKind: actor.kind,
    actorId: actor.id,
    actorName: actor.name,
    action: e.action,
    targetType: e.targetType,
    targetId: e.targetId ?? null,
    before: e.before ?? null,
    after: e.after ?? null,
  });
}

/**
 * The ids of the active (not retired) teams a person is on. The one place both the leave guard and the "can leave?" state in the
 * team settings read from, so the two cannot disagree.
 */
export async function activeTeamIdsOf(q: Q, workspaceId: string, userId: string): Promise<string[]> {
  const { teamMembers: pm, teams } = schema;
  const rows = await q
    .select({ id: pm.teamId })
    .from(pm)
    .innerJoin(teams, and(eq(teams.id, pm.teamId), eq(teams.workspaceId, pm.workspaceId)))
    .where(and(eq(pm.userId, userId), eq(pm.workspaceId, workspaceId), isNull(teams.retiredAt)));
  return rows.map((r) => r.id);
}

/** Why a person cannot leave the team, or null when they can. A retired team is always free to leave, unless the person is its last admin. */
export async function leaveBlock(q: Q, team: { id: string; workspaceId: string; retiredAt: Date | null }, userId: string): Promise<string | null> {
  const { teamMembers: pm } = schema;
  const [me] = await q.select({ role: pm.role }).from(pm).where(and(eq(pm.teamId, team.id), eq(pm.userId, userId)));
  if (!me) return "You are not in this team";
  if (me.role === "admin") {
    const [r] = await q.select({ n: sql<number>`count(*)::int` }).from(pm).where(and(eq(pm.teamId, team.id), eq(pm.role, "admin")));
    if (Number(r.n) <= 1) return "A team needs at least one admin. Name another admin first.";
  }
  if (!team.retiredAt) {
    const active = await activeTeamIdsOf(q, team.workspaceId, userId);
    if (!active.some((id) => id !== team.id)) return "This is the only active team you are on. Join or ask to be added to another team first.";
  }
  return null;
}

/** Lock the workspace's team rows for the rest of the transaction, so two lifecycle changes to its teams run one after the other. */
export async function lockWorkspaceTeams(q: Q, workspaceId: string) {
  await q.execute(sql`select id from ${schema.teams} where ${schema.teams.workspaceId} = ${workspaceId} for update`);
}
