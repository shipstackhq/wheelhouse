import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import { sha256 } from "./access";
import { AccountError } from "./accounts";
import { passwordProblem } from "./auth-policy";
import { hashPassword, randomToken, switchWorkspace, verifyPassword, type Human } from "./auth-core";
import { acceptInvite, acceptInviteAsMember, createInvite, INVITE_INVALID, listInvites, peekInvite, peekInviteAsMember, revokeInvite, seatInfo, type Issuer, type PendingInvite } from "./invites";
import * as members from "./members";
import { onboarding } from "./onboarding";
import { minutes, rateLimit } from "./rate-limit";
import { canManagePeople, isWorkspaceRole } from "./project-access";
import { listProjects, ServiceError } from "./service";
import type { WorkspaceRole } from "../db/schema";

/**
 * What the web app's workspace, agents and invite pages do, as functions of the signed-in person (WH-95). The API's controllers
 * call these and nothing else, so the rules (who may, the limits, the messages) live in one place and are tested without HTTP.
 * Every statement is scoped by the person's own workspace: an id from another workspace matches nothing and reads as "not found".
 */

const tooMany = (retryAfter: number) =>
  new AccountError("rate_limited", `Too many attempts. Try again in ${minutes(retryAfter)} minute${minutes(retryAfter) === 1 ? "" : "s"}.`, { retryAfter });

const issuerOf = (h: Human): Issuer => ({ userId: h.user.id, email: h.user.email, workspaceId: h.workspace.id, role: h.membership.role });

function requireManager(h: Human) {
  if (!canManagePeople(h.membership.role)) throw new ServiceError("forbidden", "Only workspace owners and admins can do that");
}

/** `[{ project: "WH", role: "editor" }, ...]` from a request body; anything else is dropped here and judged for real in createInvite. */
export function parseGrants(v: unknown): { project: string; role: "admin" | "editor" | "viewer" }[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((g) => {
    const o = g as { project?: unknown; role?: unknown };
    const role = o?.role === "admin" || o?.role === "editor" || o?.role === "viewer" ? o.role : null;
    return typeof o?.project === "string" && o.project && role ? [{ project: o.project, role }] : [];
  });
}

/** "a, B ,c" or ["a", "B"] to ["a", "b", "c"]: lower case, trimmed, empties dropped. */
export function parseTags(v: unknown): string[] {
  const parts = Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",") : [];
  return parts.map((t) => t.trim().toLowerCase()).filter(Boolean);
}

// ───────── the workspace page ─────────

export type WorkspaceMember = { userId: string; name: string; email: string; role: WorkspaceRole; tags: string[] };

/** The workspace page: its members, the seats, and (for owners) the invites still waiting. */
export async function workspaceOverview(h: Human) {
  const db = await getDb();
  const rows = await db
    .select({ user: schema.users, m: schema.memberships })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(eq(schema.memberships.workspaceId, h.workspace.id))
    .orderBy(schema.memberships.createdAt);
  const pendingInvites = canManagePeople(h.membership.role) ? (await listInvites(issuerOf(h))).filter((i) => i.kind === "join_workspace") : [];
  return {
    workspace: { id: h.workspace.id, name: h.workspace.name },
    role: h.membership.role,
    members: rows.map(({ user: u, m }): WorkspaceMember => ({ userId: u.id, name: u.name, email: u.email, role: m.role, tags: m.tags })),
    seats: await seatInfo(h.workspace.id),
    pendingInvites,
  };
}

/** Owners and admins change a member's role and tags; only an owner can make or unmake an owner. The last owner cannot be demoted. */
export async function updateMemberAs(h: Human, input: { userId: string; role: unknown; tags: unknown }): Promise<WorkspaceMember> {
  requireManager(h);
  const role = isWorkspaceRole(input.role) ? input.role : null;
  if (!role) throw new ServiceError("invalid", "Choose a role: owner, admin, member, viewer or guest", { fields: { role: "Choose a role" } });
  const current = (await workspaceOverview(h)).members.find((m) => m.userId === input.userId)?.role;
  if (h.membership.role !== "owner" && (role === "owner" || current === "owner")) throw new ServiceError("forbidden", "Only an owner can make or change an owner");
  const tags = parseTags(input.tags).slice(0, 20);
  const changed = await members.updateMember(h.workspace.id, h.user.id, { userId: input.userId, role, tags });
  if (!changed) {
    const existing = (await workspaceOverview(h)).members.some((m) => m.userId === input.userId);
    if (!existing) throw new ServiceError("not_found", "Member not found");
    throw new ServiceError("conflict", "A workspace needs at least one owner");
  }
  return (await workspaceOverview(h)).members.find((m) => m.userId === input.userId)!;
}

/** Owners and admins remove a member (an admin cannot remove an owner). Nobody removes themselves here. */
export async function removeMemberAs(h: Human, userId: string) {
  requireManager(h);
  const target = (await workspaceOverview(h)).members.find((m) => m.userId === userId);
  if (target?.role === "owner" && h.membership.role !== "owner") throw new ServiceError("forbidden", "Only an owner can remove an owner");
  if (userId === h.user.id) throw new ServiceError("invalid", "You cannot remove yourself");
  if (!(await members.removeMember(h.workspace.id, h.user.id, userId))) throw new ServiceError("not_found", "Member not found");
  return { ok: true as const };
}

/** The signed-in person changes their own password; the current one must be right. */
export async function changePasswordAs(h: Human, input: { current: string; next: string }) {
  const weak = passwordProblem(input.next);
  if (weak) throw new ServiceError("invalid", weak, { fields: { next: weak } });
  if (!(await verifyPassword(input.current, h.user.passwordHash))) {
    throw new ServiceError("invalid", "Current password is wrong", { fields: { current: "Current password is wrong" } });
  }
  const db = await getDb();
  await db.update(schema.users).set({ passwordHash: await hashPassword(input.next) }).where(eq(schema.users.id, h.user.id));
  return { ok: true as const };
}

// ───────── agents and API keys ─────────

export type KeyView = { id: string; name: string; prefix: string; createdAt: Date; lastUsedAt: Date | null; revokedAt: Date | null; canWriteDocs: boolean };

const keyView = (k: typeof schema.apiKeys.$inferSelect): KeyView => ({
  id: k.id,
  name: k.name,
  prefix: k.prefix,
  createdAt: k.createdAt,
  lastUsedAt: k.lastUsedAt,
  revokedAt: k.revokedAt,
  canWriteDocs: k.capabilities.includes("docs:write"),
});

/** The workspace's keys, newest first. Never the key itself: only its prefix is stored in the clear. */
export async function listKeys(h: Human): Promise<KeyView[]> {
  const db = await getDb();
  const rows = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.workspaceId, h.workspace.id)).orderBy(desc(schema.apiKeys.createdAt));
  return rows.map(keyView);
}

/** The Agents page: the keys and the commands to paste. With one project its real key goes in the commands, with several a KEY placeholder. */
export async function agentsPage(h: Human, origin: string) {
  const workspaceProjects = (await listProjects(h.actor)).map((p) => ({ key: p.key }));
  return { keys: await listKeys(h), setup: onboarding({ origin, projectKey: workspaceProjects.length === 1 ? workspaceProjects[0].key : null }) };
}

/** Create a key. The secret is returned here and nowhere else; only its hash is stored. 10 an hour per person. */
export async function createKeyAs(h: Human, name: string) {
  const hit = rateLimit(`create-key:${h.user.id}`, 10, 60 * 60_000);
  if (!hit.ok) throw tooMany(hit.retryAfter);
  const label = name.trim().slice(0, 100) || "Claude agent";
  const secret = `wh_${randomToken(24)}`;
  const db = await getDb();
  const [row] = await db
    .insert(schema.apiKeys)
    .values({ workspaceId: h.workspace.id, name: label, prefix: secret.slice(0, 10), keyHash: sha256(secret), createdBy: h.user.id })
    .returning();
  return { key: keyView(row), secret };
}

export async function revokeKeyAs(h: Human, id: string) {
  if (!(await members.revokeApiKey(h.workspace.id, id))) throw new ServiceError("not_found", "API key not found");
  return { ok: true as const };
}

/** Grant or take away the "docs:write" capability (WH-51) on one of the workspace's own keys. */
export async function setKeyDocsWriteAs(h: Human, id: string, canWrite: boolean): Promise<KeyView> {
  const db = await getDb();
  const [key] = await db.select().from(schema.apiKeys).where(and(eq(schema.apiKeys.id, id), eq(schema.apiKeys.workspaceId, h.workspace.id)));
  if (!key) throw new ServiceError("not_found", "API key not found");
  const next = canWrite ? [...new Set([...key.capabilities, "docs:write"])] : key.capabilities.filter((c) => c !== "docs:write");
  const [row] = await db
    .update(schema.apiKeys)
    .set({ capabilities: next })
    .where(and(eq(schema.apiKeys.id, id), eq(schema.apiKeys.workspaceId, h.workspace.id)))
    .returning();
  return keyView(row);
}

// ───────── invites ─────────

/** Pending invites the person may see: a workspace's join invites (owners), new-workspace invites (instance admins). */
export async function pendingInvites(h: Human, kind: "join_workspace" | "new_workspace"): Promise<PendingInvite[]> {
  return (await listInvites(issuerOf(h))).filter((i) => i.kind === kind);
}

/**
 * Create an invite link. The token goes in the URL fragment so it never reaches server logs, proxies or Referer headers, and it
 * is returned only here. Owners and admins only (checked in invites.ts); 20 an hour per person.
 */
export async function createInviteAs(
  h: Human,
  input: { kind: unknown; email: string; role?: unknown; tags?: unknown; workspace?: string; projects?: unknown },
  origin: string,
) {
  const hit = rateLimit(`invite-create:${h.user.id}`, 20, 60 * 60_000);
  if (!hit.ok) throw tooMany(hit.retryAfter);
  const kind = input.kind === "new_workspace" ? "new_workspace" : "join_workspace";
  const inv = await createInvite(issuerOf(h), {
    kind,
    email: String(input.email ?? ""),
    role: isWorkspaceRole(input.role) ? input.role : "member",
    tags: parseTags(input.tags),
    workspaceName: String(input.workspace ?? ""),
    projects: parseGrants(input.projects),
  });
  return { id: inv.id, email: inv.email, kind: inv.kind, expiresAt: inv.expiresAt, link: `${origin.replace(/\/+$/, "")}/invite#${inv.token}` };
}

export async function revokeInviteAs(h: Human, id: string) {
  await revokeInvite(issuerOf(h), id);
  return { ok: true as const };
}

/** What the invite page shows before the person picks a password. The same answer for every bad link; 30 tries per 15 minutes per address. */
export async function peekInviteAs(token: string, ip: string) {
  const hit = rateLimit(`invite-ip:${ip}`, 30, 15 * 60_000);
  if (!hit.ok) throw tooMany(hit.retryAfter);
  const invite = await peekInvite(String(token ?? ""));
  if (!invite) throw new ServiceError("invalid", INVITE_INVALID);
  return invite;
}

/** Accept an invite: creates the account (and a workspace for a new-workspace invite). The host then starts the session. */
export async function acceptInviteAs(input: { token: string; name: string; password: string; confirm: string }, ip: string) {
  const hit = rateLimit(`invite-ip:${ip}`, 30, 15 * 60_000);
  if (!hit.ok) throw tooMany(hit.retryAfter);
  if (input.password !== input.confirm) throw new ServiceError("invalid", "The two passwords do not match", { fields: { confirm: "The two passwords do not match" } });
  return acceptInvite({ token: String(input.token ?? ""), name: input.name, password: input.password });
}

/**
 * What a signed-in person is invited to when the invite was sent to their own address and they already have an account.
 * The same answer for every bad link (and for someone else's invite); 30 tries per 15 minutes per person.
 */
export async function peekInviteAsMemberAs(h: Human, token: string) {
  const hit = rateLimit(`invite-user:${h.user.id}`, 30, 15 * 60_000);
  if (!hit.ok) throw tooMany(hit.retryAfter);
  const invite = await peekInviteAsMember(h.user, String(token ?? ""));
  if (!invite) throw new ServiceError("invalid", INVITE_INVALID);
  return invite;
}

/** An existing account joins another workspace through an invite sent to its own address, then this session moves into it. */
export async function acceptInviteAsMemberAs(h: Human, token: string, sessionToken: string) {
  const hit = rateLimit(`invite-user:${h.user.id}`, 30, 15 * 60_000);
  if (!hit.ok) throw tooMany(hit.retryAfter);
  const { workspaceId } = await acceptInviteAsMember(h.user, String(token ?? ""));
  const workspace = await switchWorkspace(sessionToken, h.user.id, workspaceId);
  return { workspace: workspace ?? { id: workspaceId, name: "" } };
}
