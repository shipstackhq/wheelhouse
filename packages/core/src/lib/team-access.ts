import { and, eq } from "drizzle-orm";
import { schema } from "../db";
import type { TeamRole, WorkspaceRole } from "../db/schema";
import type { Actor } from "./access";
import type { Q } from "./service";
import { ServiceError } from "./service-error";

/**
 * Who can open a team (ADR-23). A team is reachable only through a row in `team_members`; the workspace role never
 * opens one by itself, not even an owner's. This file holds the rule and the audit trail; `requireTeam` and `resolveTicket` in
 * service.ts apply it, which is what puts every read and write path behind it.
 *
 * Agent keys and system actors (a GitHub webhook) are not people and have no row here. Until keys are scoped to teams (a later step of the same design) a key
 * keeps the access it has always had: every team in its own workspace, and nothing outside it.
 */

export type Need = "read" | "edit" | "admin";
const NEED_RANK: Record<Need, number> = { read: 1, edit: 2, admin: 3 };
const ROLE_RANK: Record<TeamRole, number> = { viewer: 1, editor: 2, admin: 3 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An id from a request that is not even shaped like one matches nothing: asking Postgres about it would be a 500, not a "not found". */
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

export const roleAllows = (role: TeamRole, need: Need) => ROLE_RANK[role] >= NEED_RANK[need];

/** The role a person really has on a team: a workspace Viewer stays read only whatever role a team gave them. */
export function effectiveRole(teamRole: TeamRole | null, workspaceRole: WorkspaceRole | null): TeamRole | null {
  if (!teamRole || !workspaceRole) return null;
  return workspaceRole === "viewer" ? "viewer" : teamRole;
}

/** The actor's role on one team, or null when they cannot open it. The membership join also drops anyone removed from the workspace. */
export async function roleOnTeam(q: Q, actor: Actor, teamId: string): Promise<TeamRole | null> {
  if (actor.kind === "agent" || actor.system) return "editor";
  const { teamMembers: pm, memberships } = schema;
  const [row] = await q
    .select({ role: pm.role, workspaceRole: memberships.role })
    .from(pm)
    .innerJoin(memberships, and(eq(memberships.userId, pm.userId), eq(memberships.workspaceId, pm.workspaceId)))
    .where(and(eq(pm.teamId, teamId), eq(pm.userId, actor.id), eq(pm.workspaceId, actor.workspaceId)));
  return row ? effectiveRole(row.role, row.workspaceRole) : null;
}

/** Ids of the workspace's teams the actor can open, or null for "all of them" (agent keys). Used by every cross-team query. */
export async function visibleTeamIds(q: Q, actor: Actor): Promise<string[] | null> {
  if (actor.kind === "agent" || actor.system) return null;
  const { teamMembers: pm, memberships } = schema;
  const rows = await q
    .select({ id: pm.teamId, workspaceRole: memberships.role })
    .from(pm)
    .innerJoin(memberships, and(eq(memberships.userId, pm.userId), eq(memberships.workspaceId, pm.workspaceId)))
    .where(and(eq(pm.userId, actor.id), eq(pm.workspaceId, actor.workspaceId)));
  return rows.map((r) => r.id);
}

/** The actor's role in each of their teams, by team id (null for an agent key or system actor, who are editors everywhere). */
export async function teamRoleMap(q: Q, actor: Actor): Promise<Map<string, TeamRole> | null> {
  if (actor.kind === "agent" || actor.system) return null;
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

/** Who may invite people, change roles and remove members: owners and admins (ADR-23). Only an owner may make or unmake another owner. */
export const canManagePeople = (role: WorkspaceRole) => role === "owner" || role === "admin";
export const isWorkspaceRole = (v: unknown): v is WorkspaceRole => typeof v === "string" && (schema.WORKSPACE_ROLES as readonly string[]).includes(v);

/** Throws forbidden when the role cannot do what is asked; the wording says what to ask for. */
export function assertAllows(role: TeamRole, need: Need) {
  if (roleAllows(role, need)) return;
  throw new ServiceError("forbidden", need === "admin" ? "Only a team admin can do that" : "Your role on this team is read only");
}



