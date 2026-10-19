import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "../db";
import type { ProjectRole, WorkspaceRole } from "../db/schema";
import type { Actor } from "./access";
import { audit, canManagePeople, isUuid, projectRoleMap, roleOnProject, workspaceRoleOf } from "./project-access";
import { emit, findWorkspaceProject, getProject, listProjects } from "./service";
import { ServiceError } from "./service-error";

/**
 * Who is in a project and how they got there (ADR-23). Everything here is for people: an agent key cannot add or remove members.
 * Each change is checked against the caller's role, keeps at least one admin on the project, and writes an audit line.
 */

const { projectMembers: pm, memberships, users } = schema;

/** The caller's projects, each with the caller's own role in it (an agent key or the system is an editor everywhere). */
export async function listProjectsWithRole(actor: Actor) {
  const db = await getDb();
  const [projects, roles] = await Promise.all([listProjects(actor), projectRoleMap(db, actor)]);
  return projects.map((p) => ({ ...p, role: (roles?.get(p.id) ?? "editor") as ProjectRole }));
}

export type ProjectMemberView = { userId: string; name: string; email: string; role: ProjectRole; workspaceRole: WorkspaceRole; addedAt: Date };

function people(actor: Actor) {
  if (actor.kind !== "human" || actor.system) throw new ServiceError("forbidden", "Only people can manage who is in a project");
}

const isProjectRole = (v: unknown): v is ProjectRole => typeof v === "string" && (schema.PROJECT_ROLES as readonly string[]).includes(v);

/** The project's members. Any member can see who else is in it. */
export async function listProjectMembers(actor: Actor, projectRef: string) {
  const db = await getDb();
  const project = await getProject(actor, projectRef);
  const rows = await db
    .select({ userId: users.id, name: users.name, email: users.email, role: pm.role, workspaceRole: memberships.role, addedAt: pm.createdAt })
    .from(pm)
    .innerJoin(users, eq(users.id, pm.userId))
    .innerJoin(memberships, and(eq(memberships.userId, pm.userId), eq(memberships.workspaceId, pm.workspaceId)))
    .where(eq(pm.projectId, project.id))
    .orderBy(pm.createdAt);
  return { project: { id: project.id, key: project.key, name: project.name }, myRole: await roleOnProject(db, actor, project.id), members: rows as ProjectMemberView[] };
}

/** Workspace members who are not in the project yet, for the "add someone" list. Project admins only. */
export async function listAddableMembers(actor: Actor, projectRef: string) {
  people(actor);
  const db = await getDb();
  const project = await getProject(actor, projectRef, "admin");
  const rows = await db
    .select({ userId: users.id, name: users.name, email: users.email, workspaceRole: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.workspaceId, actor.workspaceId),
        sql`not exists (select 1 from ${pm} where ${pm.projectId} = ${project.id} and ${pm.userId} = ${memberships.userId})`,
      ),
    )
    .orderBy(users.name);
  return rows;
}

async function adminCount(q: Parameters<typeof audit>[0], projectId: string) {
  const [r] = await q.select({ n: sql<number>`count(*)::int` }).from(pm).where(and(eq(pm.projectId, projectId), eq(pm.role, "admin")));
  return Number(r.n);
}

/** Add a workspace member to the project. Project admins only; the person must already be in the workspace. */
export async function addProjectMember(actor: Actor, projectRef: string, input: { userId: string; role: unknown }) {
  people(actor);
  if (!isProjectRole(input.role)) throw new ServiceError("invalid", "Choose a project role: admin, editor or viewer");
  const db = await getDb();
  const project = await getProject(actor, projectRef, "admin");
  if (!isUuid(input.userId)) throw new ServiceError("not_found", "That person is not in this workspace");
  const ws = await workspaceRoleOf(db, actor.workspaceId, input.userId);
  if (!ws) throw new ServiceError("not_found", "That person is not in this workspace");
  const role = input.role;
  return db.transaction(async (tx) => {
    const [dup] = await tx.select({ userId: pm.userId }).from(pm).where(and(eq(pm.projectId, project.id), eq(pm.userId, input.userId)));
    if (dup) throw new ServiceError("conflict", "They are already in this project");
    await tx.insert(pm).values({ projectId: project.id, userId: input.userId, workspaceId: actor.workspaceId, role, addedBy: actor.id });
    await audit(tx, actor, { action: "project.member_added", targetType: "user", targetId: input.userId, projectId: project.id, after: { role } });
    return { userId: input.userId, role };
  });
}

/** Change someone's role in the project. Project admins only; the last admin cannot be demoted. */
export async function setProjectMemberRole(actor: Actor, projectRef: string, userId: string, roleIn: unknown) {
  people(actor);
  if (!isProjectRole(roleIn)) throw new ServiceError("invalid", "Choose a project role: admin, editor or viewer");
  const role = roleIn;
  const db = await getDb();
  const project = await getProject(actor, projectRef, "admin");
  if (!isUuid(userId)) throw new ServiceError("not_found", "They are not in this project");
  return db.transaction(async (tx) => {
    const [cur] = await tx.select({ role: pm.role }).from(pm).where(and(eq(pm.projectId, project.id), eq(pm.userId, userId)));
    if (!cur) throw new ServiceError("not_found", "They are not in this project");
    if (cur.role === role) return { userId, role };
    if (cur.role === "admin" && (await adminCount(tx, project.id)) <= 1) throw new ServiceError("conflict", "A project needs at least one admin. Name another admin first.");
    await tx.update(pm).set({ role }).where(and(eq(pm.projectId, project.id), eq(pm.userId, userId)));
    await audit(tx, actor, { action: "project.member_role_changed", targetType: "user", targetId: userId, projectId: project.id, before: { role: cur.role }, after: { role } });
    return { userId, role };
  });
}

/** Remove someone from the project, or leave it yourself. Project admins only (anyone may leave); the last admin cannot go. */
export async function removeProjectMember(actor: Actor, projectRef: string, userId: string) {
  people(actor);
  const db = await getDb();
  const project = await getProject(actor, projectRef, userId === actor.id ? "read" : "admin");
  if (!isUuid(userId)) throw new ServiceError("not_found", "They are not in this project");
  return db.transaction(async (tx) => {
    const [cur] = await tx.select({ role: pm.role }).from(pm).where(and(eq(pm.projectId, project.id), eq(pm.userId, userId)));
    if (!cur) throw new ServiceError("not_found", "They are not in this project");
    if (cur.role === "admin" && (await adminCount(tx, project.id)) <= 1) throw new ServiceError("conflict", "A project needs at least one admin. Name another admin first.");
    await tx.delete(pm).where(and(eq(pm.projectId, project.id), eq(pm.userId, userId)));
    await audit(tx, actor, { action: userId === actor.id ? "project.member_left" : "project.member_removed", targetType: "user", targetId: userId, projectId: project.id, before: { role: cur.role } });
    return { ok: true as const };
  });
}

export type WorkspaceProjectView = { id: string; key: string; name: string; admins: string[]; memberCount: number; isMember: boolean };

/**
 * Every project of the workspace by name, with who administers it and whether you are in it: the list an owner or admin
 * uses to find a project to join. Nothing inside a project is visible from here. Owners and admins only.
 */
export async function listWorkspaceProjects(actor: Actor): Promise<WorkspaceProjectView[]> {
  people(actor);
  const db = await getDb();
  const ws = await workspaceRoleOf(db, actor.workspaceId, actor.id);
  if (!ws || !canManagePeople(ws)) throw new ServiceError("forbidden", "Only workspace owners and admins can see every project");
  const ps = await db.select().from(schema.projects).where(eq(schema.projects.workspaceId, actor.workspaceId)).orderBy(schema.projects.createdAt);
  const rows = await db
    .select({ projectId: pm.projectId, userId: pm.userId, role: pm.role, name: users.name })
    .from(pm)
    .innerJoin(users, eq(users.id, pm.userId))
    .where(eq(pm.workspaceId, actor.workspaceId));
  return ps.map((p) => {
    const mine = rows.filter((r) => r.projectId === p.id);
    return { id: p.id, key: p.key, name: p.name, admins: mine.filter((r) => r.role === "admin").map((r) => r.name), memberCount: mine.length, isMember: mine.some((r) => r.userId === actor.id) };
  });
}

/**
 * An owner or admin of the workspace joins a project as its admin, for example to recover one whose admins left. Never silent:
 * it writes an audit line and a line in the project's own activity, so its members see who came in and when.
 */
export async function joinProjectAsWorkspaceAdmin(actor: Actor, projectRef: string) {
  people(actor);
  const db = await getDb();
  const ws = await workspaceRoleOf(db, actor.workspaceId, actor.id);
  if (!ws || !canManagePeople(ws)) throw new ServiceError("forbidden", "Only workspace owners and admins can join a project");
  const project = await findWorkspaceProject(actor, projectRef, db);
  if (!project) throw new ServiceError("not_found", `Project ${projectRef} not found`);
  return db.transaction(async (tx) => {
    const [dup] = await tx.select({ userId: pm.userId }).from(pm).where(and(eq(pm.projectId, project.id), eq(pm.userId, actor.id)));
    if (dup) throw new ServiceError("conflict", "You are already in this project");
    await tx.insert(pm).values({ projectId: project.id, userId: actor.id, workspaceId: actor.workspaceId, role: "admin", addedBy: actor.id });
    await audit(tx, actor, { action: "project.admin_joined", targetType: "user", targetId: actor.id, projectId: project.id, after: { role: "admin", workspaceRole: ws } });
    await emit(tx, actor, project.id, { type: "project.admin_joined", entity: "project", entityId: project.id, summary: `${actor.name} (workspace ${ws}) joined ${project.key} as admin` });
    return { project: { id: project.id, key: project.key, name: project.name } };
  });
}

export type AuditView = { seq: number; actorName: string; action: string; targetType: string; targetId: string | null; projectKey: string | null; before: unknown; after: unknown; createdAt: Date };

/** The access audit log, newest first. Owners and admins only; `projectRef` narrows it to one project they can name. */
export async function listAudit(actor: Actor, opts: { projectRef?: string; limit?: number } = {}): Promise<AuditView[]> {
  people(actor);
  const db = await getDb();
  const ws = await workspaceRoleOf(db, actor.workspaceId, actor.id);
  if (!ws || !canManagePeople(ws)) throw new ServiceError("forbidden", "Only workspace owners and admins can read the audit log");
  const a = schema.auditEvents;
  let projectId: string | undefined;
  if (opts.projectRef) {
    const p = await findWorkspaceProject(actor, opts.projectRef, db);
    if (!p) throw new ServiceError("not_found", `Project ${opts.projectRef} not found`);
    projectId = p.id;
  }
  const rows = await db
    .select({ a, key: schema.projects.key })
    .from(a)
    .leftJoin(schema.projects, eq(schema.projects.id, a.projectId))
    .where(and(eq(a.workspaceId, actor.workspaceId), projectId ? eq(a.projectId, projectId) : undefined))
    .orderBy(desc(a.seq))
    .limit(Number.isFinite(opts.limit) ? Math.min(Math.max(Math.trunc(opts.limit!), 1), 500) : 100);
  return rows.map(({ a: r, key }) => ({ seq: r.seq, actorName: r.actorName, action: r.action, targetType: r.targetType, targetId: r.targetId, projectKey: key, before: r.before, after: r.after, createdAt: r.createdAt }));
}
