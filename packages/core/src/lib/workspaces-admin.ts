import { and, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { getDb, schema } from "../db";
import { isInstanceAdmin, maxWorkspaceMembers } from "./auth-policy";
import type { WorkspaceRole } from "../db/schema";

/**
 * Instance-admin view of the workspaces on this server, and the switch that cuts a whole workspace off (WH-52).
 *
 * Metadata only: names, emails, counts, dates. Nothing a workspace wrote (tickets, comments, the map) is read here.
 * Suspending is reversible: it records who/when/why on the workspace, signs its members out, and the checks in
 * auth.ts and invites.ts refuse the workspace while the flag is set. Restoring clears the flag.
 */

const { workspaces, memberships, users, invites, projects, events, apiKeys, sessions } = schema;

export type Admin = { userId: string; email: string; workspaceId: string };

export class AdminError extends Error {
  constructor(public code: "forbidden" | "not_found" | "invalid" | "conflict", message: string) {
    super(message);
  }
}

function requireAdmin(a: Admin) {
  if (!isInstanceAdmin(a.email)) throw new AdminError("forbidden", "Only instance admins can do that");
}

const asDate = (v: unknown) => (v ? new Date(v as string | Date) : null);

export type WorkspaceSummary = {
  id: string;
  name: string;
  createdAt: Date;
  suspendedAt: Date | null;
  suspendedReason: string | null;
  owners: { name: string; email: string }[];
  members: number;
  pendingInvites: number;
  seatsUsed: number;
  maxSeats: number;
  projects: number;
  lastActivity: Date | null;
  invitedBy: { name: string; email: string } | null;
  isYours: boolean;
};

export async function listWorkspaces(admin: Admin, now = new Date()): Promise<WorkspaceSummary[]> {
  requireAdmin(admin);
  const db = await getDb();
  const [workspaceRows, memberRows, pendingRows, projectRows, eventRows, keyRows, founderRows] = await Promise.all([
    db.select().from(workspaces).orderBy(workspaces.createdAt),
    db
      .select({ workspaceId: memberships.workspaceId, role: memberships.role, name: users.name, email: users.email })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId)),
    db
      .select({ workspaceId: invites.workspaceId, n: sql<number>`count(*)::int` })
      .from(invites)
      .where(and(eq(invites.kind, "join_workspace"), isNull(invites.usedAt), isNull(invites.revokedAt), gt(invites.expiresAt, now)))
      .groupBy(invites.workspaceId),
    db.select({ workspaceId: projects.workspaceId, n: sql<number>`count(*)::int` }).from(projects).groupBy(projects.workspaceId),
    db.select({ workspaceId: events.workspaceId, at: sql<string | null>`max(${events.createdAt})` }).from(events).groupBy(events.workspaceId),
    db.select({ workspaceId: apiKeys.workspaceId, at: sql<string | null>`max(${apiKeys.lastUsedAt})` }).from(apiKeys).groupBy(apiKeys.workspaceId),
    // who sent the new-workspace invite each founder used
    db
      .select({ usedBy: invites.usedBy, name: users.name, email: users.email })
      .from(invites)
      .innerJoin(users, eq(users.id, invites.createdBy))
      .where(and(eq(invites.kind, "new_workspace"), isNotNull(invites.usedBy))),
  ]);

  const memberWorkspace = new Map<string, string>(); // user id -> workspace id, to find a founder's workspace
  const byWorkspace = new Map<string, typeof memberRows>();
  for (const m of memberRows) {
    byWorkspace.set(m.workspaceId, [...(byWorkspace.get(m.workspaceId) ?? []), m]);
  }
  const userWorkspace = await db.select({ userId: memberships.userId, workspaceId: memberships.workspaceId }).from(memberships);
  for (const u of userWorkspace) memberWorkspace.set(u.userId, u.workspaceId);
  const invitedBy = new Map<string, { name: string; email: string }>();
  for (const f of founderRows) {
    const t = f.usedBy ? memberWorkspace.get(f.usedBy) : undefined;
    if (t) invitedBy.set(t, { name: f.name, email: f.email });
  }
  const pending = new Map(pendingRows.map((r) => [r.workspaceId, r.n]));
  const projCount = new Map(projectRows.map((r) => [r.workspaceId, r.n]));
  const lastEvent = new Map(eventRows.map((r) => [r.workspaceId, asDate(r.at)]));
  const lastKey = new Map(keyRows.map((r) => [r.workspaceId, asDate(r.at)]));
  const max = maxWorkspaceMembers();

  return workspaceRows.map((t) => {
    const ms = byWorkspace.get(t.id) ?? [];
    const p = pending.get(t.id) ?? 0;
    const times = [lastEvent.get(t.id), lastKey.get(t.id)].filter((d): d is Date => !!d);
    return {
      id: t.id,
      name: t.name,
      createdAt: t.createdAt,
      suspendedAt: t.suspendedAt,
      suspendedReason: t.suspendedReason,
      owners: ms.filter((m) => m.role === "owner").map((m) => ({ name: m.name, email: m.email })),
      members: ms.length,
      pendingInvites: p,
      seatsUsed: ms.length + p,
      maxSeats: max,
      projects: projCount.get(t.id) ?? 0,
      lastActivity: times.length ? new Date(Math.max(...times.map((d) => d.getTime()))) : null,
      invitedBy: invitedBy.get(t.id) ?? null,
      isYours: t.id === admin.workspaceId,
    };
  });
}

export type WorkspaceDetail = WorkspaceSummary & {
  suspendedBy: { name: string; email: string } | null;
  memberList: { userId: string; name: string; email: string; role: WorkspaceRole; tags: string[]; joinedAt: Date }[];
  inviteList: { id: string; kind: "new_workspace" | "join_workspace"; email: string; role: string; status: "pending" | "used" | "revoked" | "expired"; expiresAt: Date; createdAt: Date }[];
  keys: { id: string; name: string; prefix: string; createdAt: Date; lastUsedAt: Date | null; revokedAt: Date | null }[];
};

export async function getWorkspaceDetail(admin: Admin, workspaceId: string, now = new Date()): Promise<WorkspaceDetail> {
  requireAdmin(admin);
  const summary = (await listWorkspaces(admin, now)).find((t) => t.id === workspaceId);
  if (!summary) throw new AdminError("not_found", "Workspace not found");
  const db = await getDb();
  const [workspace] = await db.select({ suspendedBy: workspaces.suspendedBy }).from(workspaces).where(eq(workspaces.id, workspaceId));
  const [by] = workspace?.suspendedBy
    ? await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, workspace.suspendedBy))
    : [];
  const memberList = await db
    .select({ userId: users.id, name: users.name, email: users.email, role: memberships.role, tags: memberships.tags, joinedAt: memberships.createdAt })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.workspaceId, workspaceId))
    .orderBy(memberships.createdAt);
  const memberIds = memberList.map((m) => m.userId);
  const inviteRows = await db
    .select()
    .from(invites)
    .where(memberIds.length ? or(eq(invites.workspaceId, workspaceId), inArray(invites.usedBy, memberIds)) : eq(invites.workspaceId, workspaceId))
    .orderBy(desc(invites.createdAt));
  const inviteList = inviteRows.map((i) => ({
    id: i.id,
    kind: i.kind,
    email: i.email,
    role: i.role,
    status: (i.usedAt ? "used" : i.revokedAt ? "revoked" : i.expiresAt <= now ? "expired" : "pending") as "pending" | "used" | "revoked" | "expired",
    expiresAt: i.expiresAt,
    createdAt: i.createdAt,
  }));
  const keys = await db
    .select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, createdAt: apiKeys.createdAt, lastUsedAt: apiKeys.lastUsedAt, revokedAt: apiKeys.revokedAt })
    .from(apiKeys)
    .where(eq(apiKeys.workspaceId, workspaceId))
    .orderBy(desc(apiKeys.createdAt));
  return { ...summary, suspendedBy: by ?? null, memberList, inviteList, keys };
}

/**
 * Cut a workspace off. Needs the workspace's exact name as confirmation, refuses the admin's own workspace (no self lockout),
 * and signs every member out in the same transaction.
 */
export async function suspendWorkspace(admin: Admin, workspaceId: string, input: { reason?: string; confirmName: string }, now = new Date()) {
  requireAdmin(admin);
  if (workspaceId === admin.workspaceId) throw new AdminError("conflict", "You cannot suspend your own workspace");
  const db = await getDb();
  const result = await db.transaction(async (tx) => {
    const [t] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
    if (!t) throw new AdminError("not_found", "Workspace not found");
    if (t.suspendedAt) throw new AdminError("conflict", "That workspace is already suspended");
    if (input.confirmName.trim() !== t.name) throw new AdminError("invalid", "Type the workspace name exactly to confirm");
    await tx
      .update(workspaces)
      .set({ suspendedAt: now, suspendedBy: admin.userId, suspendedReason: (input.reason ?? "").trim().slice(0, 500) || null })
      .where(eq(workspaces.id, workspaceId));
    const members = tx.select({ id: memberships.userId }).from(memberships).where(eq(memberships.workspaceId, workspaceId));
    const gone = await tx.delete(sessions).where(inArray(sessions.userId, members)).returning({ id: sessions.id });
    return { name: t.name, sessionsEnded: gone.length };
  });
  console.info(`[admin] workspace suspended ${workspaceId} by=${admin.userId} sessions_ended=${result.sessionsEnded}`);
  return result;
}

export async function restoreWorkspace(admin: Admin, workspaceId: string) {
  requireAdmin(admin);
  const db = await getDb();
  const rows = await db
    .update(workspaces)
    .set({ suspendedAt: null, suspendedBy: null, suspendedReason: null })
    .where(and(eq(workspaces.id, workspaceId), isNotNull(workspaces.suspendedAt)))
    .returning({ id: workspaces.id });
  if (!rows.length) throw new AdminError("conflict", "That workspace is not suspended");
  console.info(`[admin] workspace restored ${workspaceId} by=${admin.userId}`);
}
