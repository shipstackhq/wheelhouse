"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  createSession,
  destroySession,
  hashPassword,
  verifyPassword,
  requireHuman,
  randomToken,
  sha256,
  signupAllowed,
} from "@/lib/auth";
import { clientIp, minutes, rateLimit, resetRateLimit } from "@/lib/rate-limit";
import { passwordProblem } from "@/lib/auth-policy";
import {
  acceptInvite,
  createInvite,
  InviteError,
  InviteFailure,
  INVITE_INVALID,
  peekInvite,
  revokeInvite,
  type Issuer,
} from "@/lib/invites";
import * as svc from "@/lib/service";
import { askMap } from "@/lib/ask";

export type FormState = { error?: string; ok?: string; secret?: string } | undefined;

const emailOk = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

function fail(e: unknown): FormState {
  if (e instanceof svc.ServiceError) return { error: e.message };
  throw e;
}

// ───────── auth ─────────

const tooMany = (retryAfter: number): FormState => ({
  error: `Too many attempts. Try again in ${minutes(retryAfter)} minute${minutes(retryAfter) === 1 ? "" : "s"}.`,
});

export async function signup(_: FormState, fd: FormData): Promise<FormState> {
  if (!(await signupAllowed())) return { error: "Signups are closed. Ask a team owner to add you." };
  const ipHit = rateLimit(`signup:${clientIp(await headers())}`, 10, 60 * 60_000);
  if (!ipHit.ok) return tooMany(ipHit.retryAfter);
  const name = String(fd.get("name") ?? "").trim();
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  const password = String(fd.get("password") ?? "");
  const teamName = String(fd.get("team") ?? "").trim() || `${name}'s team`;
  if (!name || !emailOk(email)) return { error: "Enter your name and a valid email" };
  const weak = passwordProblem(password);
  if (weak) return { error: weak };

  const db = await getDb();
  const [exists] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
  if (exists) return { error: "An account with that email already exists" };

  const passwordHash = await hashPassword(password);
  const userId = await db.transaction(async (tx) => {
    const [u] = await tx.insert(schema.users).values({ email, name, passwordHash }).returning();
    const [t] = await tx.insert(schema.teams).values({ name: teamName }).returning();
    await tx.insert(schema.memberships).values({ userId: u.id, teamId: t.id, role: "owner" });
    return u.id;
  });
  await createSession(userId);
  redirect("/");
}

export async function login(_: FormState, fd: FormData): Promise<FormState> {
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  const password = String(fd.get("password") ?? "");
  // Per address (spraying many accounts) and per account (guessing one password from many addresses).
  const ipHit = rateLimit(`login-ip:${clientIp(await headers())}`, 30, 15 * 60_000);
  if (!ipHit.ok) return tooMany(ipHit.retryAfter);
  const emailHit = rateLimit(`login-email:${email}`, 8, 15 * 60_000);
  if (!emailHit.ok) return tooMany(emailHit.retryAfter);
  const db = await getDb();
  const [u] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  if (!u || !(await verifyPassword(password, u.passwordHash))) return { error: "Invalid email or password" };
  resetRateLimit(`login-email:${email}`);
  await createSession(u.id);
  redirect("/");
}

export async function logout() {
  await destroySession();
  redirect("/login");
}

// ───────── team (owner-only writes) ─────────

async function requireOwner() {
  const ctx = await requireHuman();
  if (ctx.membership.role !== "owner") throw new svc.ServiceError("forbidden", "Only team owners can do that");
  return ctx;
}

const parseTags = (s: string) =>
  s
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

// ───────── invites (WH-49) ─────────

async function issuer(): Promise<Issuer> {
  const { user, team, membership } = await requireHuman();
  return { userId: user.id, email: user.email, teamId: team.id, role: membership.role };
}

async function inviteOrigin() {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, "");
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
}

/** The token goes in the URL fragment so it never reaches server logs, proxies or Referer headers. */
export async function createInviteAction(_: FormState, fd: FormData): Promise<FormState> {
  const iss = await issuer();
  const hit = rateLimit(`invite-create:${iss.userId}`, 20, 60 * 60_000);
  if (!hit.ok) return tooMany(hit.retryAfter);
  const kind = fd.get("kind") === "new_team" ? "new_team" : "join_team";
  try {
    const inv = await createInvite(iss, {
      kind,
      email: String(fd.get("email") ?? ""),
      role: fd.get("role") === "owner" ? "owner" : "member",
      tags: parseTags(String(fd.get("tags") ?? "")),
      teamName: String(fd.get("team") ?? ""),
    });
    revalidatePath(kind === "new_team" ? "/admin/invites" : "/team");
    return {
      ok: `Invite created for ${inv.email}. Send them this link. It is shown only once, works for one person and expires on ${inv.expiresAt.toISOString().slice(0, 10)}:`,
      secret: `${await inviteOrigin()}/invite#${inv.token}`,
    };
  } catch (e) {
    if (e instanceof InviteError) return { error: e.message };
    throw e;
  }
}

export async function revokeInviteAction(fd: FormData) {
  const iss = await issuer();
  try {
    await revokeInvite(iss, String(fd.get("id") ?? ""));
  } catch (e) {
    if (!(e instanceof InviteError)) throw e;
  }
  revalidatePath("/team");
  revalidatePath("/admin/invites");
}

export type InvitePeek = { invite?: { email: string; kind: "new_team" | "join_team"; teamName: string | null }; error?: string };

/** Lets the invite page show the invitee's email before they choose a password. Same answer for every bad link. */
export async function lookupInviteAction(token: string): Promise<InvitePeek> {
  const hit = rateLimit(`invite-ip:${clientIp(await headers())}`, 30, 15 * 60_000);
  if (!hit.ok) return tooMany(hit.retryAfter) as { error: string };
  const invite = await peekInvite(String(token ?? ""));
  return invite ? { invite } : { error: INVITE_INVALID };
}

export async function acceptInviteAction(_: FormState, fd: FormData): Promise<FormState> {
  const hit = rateLimit(`invite-ip:${clientIp(await headers())}`, 30, 15 * 60_000);
  if (!hit.ok) return tooMany(hit.retryAfter);
  const password = String(fd.get("password") ?? "");
  if (password !== String(fd.get("confirm") ?? "")) return { error: "The two passwords do not match" };
  try {
    const r = await acceptInvite({ token: String(fd.get("token") ?? ""), name: String(fd.get("name") ?? ""), password });
    await createSession(r.userId);
  } catch (e) {
    if (e instanceof InviteError) return { error: e.message };
    if (e instanceof InviteFailure) return { error: INVITE_INVALID };
    throw e;
  }
  redirect("/");
}

export async function updateMember(fd: FormData) {
  const { team, user } = await requireOwner();
  const userId = String(fd.get("userId"));
  const role = fd.get("role") === "owner" ? "owner" : "member";
  const tags = parseTags(String(fd.get("tags") ?? ""));
  const db = await getDb();
  if (userId === user.id && role !== "owner") {
    const owners = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.teamId, team.id), eq(schema.memberships.role, "owner")));
    if (Number(owners[0].n) <= 1) return; // keep at least one owner
  }
  await db
    .update(schema.memberships)
    .set({ role, tags })
    .where(and(eq(schema.memberships.teamId, team.id), eq(schema.memberships.userId, userId)));
  revalidatePath("/team");
}

export async function removeMember(fd: FormData) {
  const { team, user } = await requireOwner();
  const userId = String(fd.get("userId"));
  if (userId === user.id) return;
  const db = await getDb();
  await db.delete(schema.memberships).where(and(eq(schema.memberships.teamId, team.id), eq(schema.memberships.userId, userId)));
  revalidatePath("/team");
}

export async function changePassword(_: FormState, fd: FormData): Promise<FormState> {
  const { user } = await requireHuman();
  const current = String(fd.get("current") ?? "");
  const next = String(fd.get("next") ?? "");
  const weak = passwordProblem(next);
  if (weak) return { error: weak };
  if (!(await verifyPassword(current, user.passwordHash))) return { error: "Current password is wrong" };
  const db = await getDb();
  await db.update(schema.users).set({ passwordHash: await hashPassword(next) }).where(eq(schema.users.id, user.id));
  return { ok: "Password updated" };
}

// ───────── api keys ─────────

export async function createApiKey(_: FormState, fd: FormData): Promise<FormState> {
  const { team, user } = await requireHuman();
  const hit = rateLimit(`create-key:${user.id}`, 10, 60 * 60_000);
  if (!hit.ok) return tooMany(hit.retryAfter);
  const name = String(fd.get("name") ?? "").trim() || "Claude agent";
  const key = `wh_${randomToken(24)}`;
  const db = await getDb();
  await db.insert(schema.apiKeys).values({ teamId: team.id, name, prefix: key.slice(0, 10), keyHash: sha256(key), createdBy: user.id });
  revalidatePath("/team");
  return { ok: `Key "${name}" created. Copy it now — it won't be shown again.`, secret: key };
}

export async function revokeApiKey(fd: FormData) {
  const { team } = await requireHuman();
  const db = await getDb();
  await db
    .update(schema.apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.apiKeys.id, String(fd.get("id"))), eq(schema.apiKeys.teamId, team.id)));
  revalidatePath("/team");
}

// ───────── projects ─────────

export async function createProjectAction(_: FormState, fd: FormData): Promise<FormState> {
  let key: string;
  try {
    const { actor } = await requireHuman();
    const p = await svc.createProject(actor, {
      name: String(fd.get("name") ?? ""),
      key: String(fd.get("key") ?? "") || undefined,
      description: String(fd.get("description") ?? ""),
    });
    key = p.key;
  } catch (e) {
    return fail(e);
  }
  redirect(`/p/${key}`);
}

// ───────── board (called from client components) ─────────

type R<T> = { ok: true; data: T } | { ok: false; error: string };
async function wrap<T>(fn: () => Promise<T>): Promise<R<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (e instanceof svc.ServiceError) return { ok: false, error: e.message };
    throw e;
  }
}

/** Cheap poll target: the latest event seq for a project. */
export async function latestSeq(projectKey: string) {
  const { actor } = await requireHuman();
  const p = await svc.getProject(actor, projectKey);
  const db = await getDb();
  const [row] = await db
    .select({ seq: schema.events.seq })
    .from(schema.events)
    .where(eq(schema.events.projectId, p.id))
    .orderBy(desc(schema.events.seq))
    .limit(1);
  return row?.seq ?? 0;
}

export async function moveTicketAction(ref: string, column: string, index: number) {
  const { actor } = await requireHuman();
  return wrap(() => svc.moveTicket(actor, ref, column, index));
}

export async function createTicketAction(projectKey: string, input: { title: string; column?: string; body?: string; priority?: svc.TicketInput["priority"] }) {
  const { actor } = await requireHuman();
  return wrap(() => svc.createTicket(actor, projectKey, input));
}

export async function updateTicketAction(ref: string, patch: svc.TicketInput, expectedVersion?: number) {
  const { actor } = await requireHuman();
  return wrap(() => svc.updateTicket(actor, ref, patch, expectedVersion));
}

export async function deleteTicketAction(ref: string) {
  const { actor } = await requireHuman();
  return wrap(() => svc.deleteTicket(actor, ref));
}

export async function getTicketAction(ref: string) {
  const { actor } = await requireHuman();
  return wrap(() => svc.getTicket(actor, ref));
}

export async function commentAction(ref: string, body: string) {
  const { actor } = await requireHuman();
  return wrap(() => svc.addComment(actor, ref, body));
}

export async function linkNodeAction(ref: string, nodeId: string, unlink = false) {
  const { actor } = await requireHuman();
  return wrap(() => svc.linkTicketNode(actor, ref, nodeId, unlink));
}

// ───────── graph ─────────

export async function getGraphAction(projectKey: string) {
  const { actor } = await requireHuman();
  return wrap(() => svc.getGraph(actor, projectKey));
}

export async function upsertNodeAction(projectKey: string, input: svc.NodeInput) {
  const { actor } = await requireHuman();
  return wrap(() => svc.upsertNode(actor, projectKey, input));
}

export async function deleteNodeAction(projectKey: string, nodeId: string) {
  const { actor } = await requireHuman();
  return wrap(() => svc.deleteNode(actor, projectKey, nodeId));
}

export async function saveLayoutAction(projectKey: string, positions: { id: string; x: number; y: number; width?: number; height?: number }[]) {
  const { actor } = await requireHuman();
  return wrap(() => svc.saveLayout(actor, projectKey, positions));
}

export async function connectNodesAction(projectKey: string, from: string, to: string, label?: string, kind: "depends" | "implements" = "depends") {
  const { actor } = await requireHuman();
  return wrap(() => svc.upsertEdge(actor, projectKey, { from, to, label, kind }));
}

export async function deleteEdgeAction(projectKey: string, edgeId: string) {
  const { actor } = await requireHuman();
  return wrap(() => svc.deleteEdge(actor, projectKey, edgeId));
}

export async function markFreshAction(projectKey: string, nodeId: string) {
  const { actor } = await requireHuman();
  return wrap(() => svc.markFresh(actor, projectKey, nodeId));
}

// ───────── flows / decisions / glossary ─────────

export async function upsertFlowAction(projectKey: string, input: svc.FlowInput) {
  const { actor } = await requireHuman();
  return wrap(() => svc.upsertFlow(actor, projectKey, input));
}

export async function deleteFlowAction(projectKey: string, flowId: string) {
  const { actor } = await requireHuman();
  return wrap(() => svc.deleteFlow(actor, projectKey, flowId));
}

export async function upsertDecisionAction(projectKey: string, input: svc.DecisionInput) {
  const { actor } = await requireHuman();
  const res = await wrap(() => svc.upsertDecision(actor, projectKey, input));
  revalidatePath(`/p/${projectKey}/decisions`);
  return res;
}

export async function upsertTermAction(projectKey: string, input: { term: string; definition: string; node?: string | null }) {
  const { actor } = await requireHuman();
  const res = await wrap(() => svc.upsertTerm(actor, projectKey, input));
  revalidatePath(`/p/${projectKey}/glossary`);
  return res;
}

export async function deleteTermAction(projectKey: string, term: string) {
  const { actor } = await requireHuman();
  const res = await wrap(() => svc.deleteTerm(actor, projectKey, term));
  revalidatePath(`/p/${projectKey}/glossary`);
  return res;
}

export async function askAction(projectKey: string, question: string, focusNodeId?: string) {
  const { actor } = await requireHuman();
  return wrap(() => askMap(actor, projectKey, question, focusNodeId));
}

export async function markAllSeenAction(fd: FormData) {
  const { actor } = await requireHuman();
  const keyId = String(fd.get("keyId") ?? "") || undefined;
  const projectRef = String(fd.get("project") ?? "") || undefined;
  await svc.markAllSeen(actor, { keyId, projectRef });
  revalidatePath("/", "layout");
}

export async function removeSessionAction(projectKey: string, sessionId: string) {
  const { actor } = await requireHuman();
  const res = await wrap(() => svc.removeSession(actor, projectKey, sessionId));
  revalidatePath("/", "layout");
  return res;
}

export async function resolveDraftAction(projectKey: string, draftId: string, action: "publish" | "discard") {
  const { actor } = await requireHuman();
  const { resolveDraft } = await import("@/lib/sync");
  return wrap(() => resolveDraft(actor, projectKey, draftId, action));
}
