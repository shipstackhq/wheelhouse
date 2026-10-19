import { and, eq } from "drizzle-orm";
import { schema } from "../db";
import type { ProjectRole, WorkspaceRole } from "../db/schema";
import type { Actor } from "./access";
import type { Q } from "./service";
import { ServiceError } from "./service-error";

/**
 * Who can open a project (ADR-23). A project is reachable only through a row in `project_members`; the workspace role never
 * opens one by itself, not even an owner's. This file holds the rule and the audit trail; `getProject` and `resolveTicket` in
 * service.ts apply it, which is what puts every read and write path behind it.
 *
 * Agent keys and system actors (a GitHub webhook) are not people and have no row here. Until keys are scoped to projects (a later step of the same design) a key
 * keeps the access it has always had: every project in its own workspace, and nothing outside it.
 */

export type Need = "read" | "edit" | "admin";
const NEED_RANK: Record<Need, number> = { read: 1, edit: 2, admin: 3 };
const ROLE_RANK: Record<ProjectRole, number> = { viewer: 1, editor: 2, admin: 3 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An id from a request that is not even shaped like one matches nothing: asking Postgres about it would be a 500, not a "not found". */
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

export const roleAllows = (role: ProjectRole, need: Need) => ROLE_RANK[role] >= NEED_RANK[need];

/** The role a person really has on a project: a workspace Viewer stays read only whatever role a project gave them. */
export function effectiveRole(projectRole: ProjectRole | null, workspaceRole: WorkspaceRole | null): ProjectRole | null {
  if (!projectRole || !workspaceRole) return null;
  return workspaceRole === "viewer" ? "viewer" : projectRole;
}

/** The actor's role on one project, or null when they cannot open it. The membership join also drops anyone removed from the workspace. */
export async function roleOnProject(q: Q, actor: Actor, projectId: string): Promise<ProjectRole | null> {
  if (actor.kind === "agent" || actor.system) return "editor";
  const { projectMembers: pm, memberships } = schema;
  const [row] = await q
    .select({ role: pm.role, workspaceRole: memberships.role })
    .from(pm)
    .innerJoin(memberships, and(eq(memberships.userId, pm.userId), eq(memberships.teamId, pm.teamId)))
    .where(and(eq(pm.projectId, projectId), eq(pm.userId, actor.id), eq(pm.teamId, actor.teamId)));
  return row ? effectiveRole(row.role, row.workspaceRole) : null;
}

/** Ids of the workspace's projects the actor can open, or null for "all of them" (agent keys). Used by every cross-project query. */
export async function visibleProjectIds(q: Q, actor: Actor): Promise<string[] | null> {
  if (actor.kind === "agent" || actor.system) return null;
  const { projectMembers: pm, memberships } = schema;
  const rows = await q
    .select({ id: pm.projectId, workspaceRole: memberships.role })
    .from(pm)
    .innerJoin(memberships, and(eq(memberships.userId, pm.userId), eq(memberships.teamId, pm.teamId)))
    .where(and(eq(pm.userId, actor.id), eq(pm.teamId, actor.teamId)));
  return rows.map((r) => r.id);
}

/** The actor's role in each of their projects, by project id (null for an agent key or system actor, who are editors everywhere). */
export async function projectRoleMap(q: Q, actor: Actor): Promise<Map<string, ProjectRole> | null> {
  if (actor.kind === "agent" || actor.system) return null;
  const { projectMembers: pm, memberships } = schema;
  const rows = await q
    .select({ id: pm.projectId, role: pm.role, workspaceRole: memberships.role })
    .from(pm)
    .innerJoin(memberships, and(eq(memberships.userId, pm.userId), eq(memberships.teamId, pm.teamId)))
    .where(and(eq(pm.userId, actor.id), eq(pm.teamId, actor.teamId)));
  return new Map(rows.flatMap((r) => { const e = effectiveRole(r.role, r.workspaceRole); return e ? [[r.id, e] as const] : []; }));
}

/** The person's role in the workspace, or null if they are not in it. */
export async function workspaceRoleOf(q: Q, teamId: string, userId: string): Promise<WorkspaceRole | null> {
  const [m] = await q
    .select({ role: schema.memberships.role })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.teamId, teamId), eq(schema.memberships.userId, userId)));
  return m?.role ?? null;
}

/** Append a line to the access audit log (never updated, never deleted). */
export async function audit(
  q: Q,
  actor: Actor,
  e: { action: string; targetType: "user" | "project" | "membership"; targetId?: string | null; projectId?: string | null; before?: Record<string, unknown> | null; after?: Record<string, unknown> | null },
) {
  await q.insert(schema.auditEvents).values({
    teamId: actor.teamId,
    projectId: e.projectId ?? null,
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
export function assertAllows(role: ProjectRole, need: Need) {
  if (roleAllows(role, need)) return;
  throw new ServiceError("forbidden", need === "admin" ? "Only a project admin can do that" : "Your role on this project is read only");
}



