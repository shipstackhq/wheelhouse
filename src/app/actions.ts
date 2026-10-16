"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@wheelhouse/core/db";
import {
  createSession,
  destroySession,
  hashPassword,
  verifyPassword,
  requireHuman,
  randomToken,
  sha256,
  signupAllowed,
  TEAM_SUSPENDED_MESSAGE,
  userTeamSuspended,
} from "@/lib/auth";
import { AdminError, restoreTeam, suspendTeam, type Admin } from "@wheelhouse/core/lib/teams-admin";
import { clientIp, minutes, rateLimit, resetRateLimit } from "@wheelhouse/core/lib/rate-limit";
import { passwordProblem } from "@wheelhouse/core/lib/auth-policy";
import {
  acceptInvite,
  createInvite,
  InviteError,
  InviteFailure,
  INVITE_INVALID,
  peekInvite,
  revokeInvite,
  type Issuer,
} from "@wheelhouse/core/lib/invites";
import * as svc from "@wheelhouse/core/lib/service";
import * as gh from "@wheelhouse/core/lib/github/service";
import { github } from "@wheelhouse/core/lib/github/runtime";
import * as members from "@wheelhouse/core/lib/members";
import { askMap } from "@wheelhouse/core/lib/ask";

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
  // Only someone who knows the password learns the team is suspended.
  if (await userTeamSuspended(u.id)) return { error: TEAM_SUSPENDED_MESSAGE };
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

// ───────── instance admin: teams (WH-52) ─────────

async function adminCtx(): Promise<Admin> {
  const { user, team } = await requireHuman();
  return { userId: user.id, email: user.email, teamId: team.id };
}

export async function suspendTeamAction(_: FormState, fd: FormData): Promise<FormState> {
  const admin = await adminCtx();
  const teamId = String(fd.get("teamId") ?? "");
  try {
    const r = await suspendTeam(admin, teamId, { confirmName: String(fd.get("confirm") ?? ""), reason: String(fd.get("reason") ?? "") });
    revalidatePath("/admin/teams");
    revalidatePath(`/admin/teams/${teamId}`);
    return { ok: `Suspended ${r.name}. ${r.sessionsEnded} sign-in${r.sessionsEnded === 1 ? "" : "s"} ended.` };
  } catch (e) {
    if (e instanceof AdminError) return { error: e.message };
    throw e;
  }
}

export async function restoreTeamAction(fd: FormData) {
  const admin = await adminCtx();
  const teamId = String(fd.get("teamId") ?? "");
  try {
    await restoreTeam(admin, teamId);
  } catch (e) {
    if (!(e instanceof AdminError)) throw e;
  }
  revalidatePath("/admin/teams");
  revalidatePath(`/admin/teams/${teamId}`);
}

export async function updateMember(fd: FormData) {
  const { team, user } = await requireOwner();
  await members.updateMember(team.id, user.id, {
    userId: String(fd.get("userId")),
    role: fd.get("role") === "owner" ? "owner" : "member",
    tags: parseTags(String(fd.get("tags") ?? "")),
  });
  revalidatePath("/team");
}

export async function removeMember(fd: FormData) {
  const { team, user } = await requireOwner();
  await members.removeMember(team.id, user.id, String(fd.get("userId")));
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
  await members.revokeApiKey(team.id, String(fd.get("id")));
  revalidatePath("/team");
}

/** Grant or revoke the "docs:write" capability on one of the team's own keys (WH-51). Off by default for every key. */
export async function setKeyDocsWriteAction(keyId: string, canWrite: boolean) {
  const { team } = await requireHuman();
  const db = await getDb();
  const [key] = await db.select({ capabilities: schema.apiKeys.capabilities }).from(schema.apiKeys).where(and(eq(schema.apiKeys.id, keyId), eq(schema.apiKeys.teamId, team.id)));
  if (!key) return { ok: false, error: "Key not found" };
  const next = canWrite ? [...new Set([...key.capabilities, "docs:write"])] : key.capabilities.filter((c) => c !== "docs:write");
  await db.update(schema.apiKeys).set({ capabilities: next }).where(and(eq(schema.apiKeys.id, keyId), eq(schema.apiKeys.teamId, team.id)));
  revalidatePath("/agents");
  return { ok: true };
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
  redirect(`/p/${key}/onboarding`);
}

/**
 * WH-69 no-code placeholder: the minimal "what are you building" textarea becomes a first concept node, so a
 * project with no repository yet still has something on the map before any code exists. Kept intentionally small
 * — a full spec/template system is WH-51/65, not this ticket.
 */
export async function createConceptFromDescriptionAction(_: FormState, fd: FormData): Promise<FormState> {
  const projectKey = String(fd.get("projectKey") ?? "");
  const description = String(fd.get("description") ?? "").trim();
  if (!description) return { error: "Write a few sentences about what you're building." };
  try {
    const { actor } = await requireHuman();
    const project = await svc.getProject(actor, projectKey);
    await svc.upsertNode(actor, projectKey, {
      name: project.name,
      layer: "concept",
      kind: "concept",
      summary: description.slice(0, 200),
      purpose: description,
    });
  } catch (e) {
    return fail(e);
  }
  revalidatePath(`/p/${projectKey}`);
  return { ok: "Added to the map." };
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

export async function saveLayoutAction(
  projectKey: string,
  positions: { id: string; x: number; y: number; width?: number; height?: number }[],
  opts?: { placed?: boolean },
) {
  const { actor } = await requireHuman();
  return wrap(() => svc.saveLayout(actor, projectKey, positions, opts));
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

// ───────── team documentation (WH-51) ─────────

export async function listDocsAction(projectKey: string) {
  const { actor } = await requireHuman();
  return wrap(() => svc.listDocs(actor, projectKey));
}

export async function getDocAction(projectKey: string, ref: string) {
  const { actor } = await requireHuman();
  return wrap(() => svc.getDoc(actor, projectKey, ref));
}

export async function createDocAction(projectKey: string, input: { title: string; body?: string; parent?: string | null; template?: string }) {
  const { actor } = await requireHuman();
  return wrap(() => svc.createDoc(actor, projectKey, input));
}

export async function listDocTemplatesAction() {
  return svc.listDocTemplates();
}

/**
 * WH-65: one-click "Create ticket" for an unchecked action item in a doc's "Action items"
 * section. One-shot only — no bidirectional sync back to the doc; the caller (docs-explorer)
 * is responsible for marking the checkbox done in the doc body after this succeeds, same as
 * any other edit through updateDocAction.
 */
export async function createTicketFromActionItemAction(projectKey: string, title: string) {
  const { actor } = await requireHuman();
  return wrap(() => svc.createTicket(actor, projectKey, { title }));
}

export async function updateDocAction(
  projectKey: string,
  ref: string,
  patch: { title?: string; body?: string; anchors?: string[] },
  expectedVersion?: number,
) {
  const { actor } = await requireHuman();
  return wrap(() => svc.updateDoc(actor, projectKey, ref, patch, expectedVersion));
}

export async function markDocFreshAction(projectKey: string, ref: string) {
  const { actor } = await requireHuman();
  return wrap(() => svc.markDocFresh(actor, projectKey, ref));
}

export async function suggestDocAnchorsAction(projectKey: string, ref: string) {
  const { actor } = await requireHuman();
  return wrap(() => svc.suggestDocAnchors(actor, projectKey, ref));
}

export async function moveDocAction(projectKey: string, ref: string, opts: { parent?: string | null; index?: number }, expectedVersion?: number) {
  const { actor } = await requireHuman();
  return wrap(() => svc.moveDoc(actor, projectKey, ref, opts, expectedVersion));
}

export async function deleteDocAction(projectKey: string, ref: string) {
  const { actor } = await requireHuman();
  return wrap(() => svc.deleteDoc(actor, projectKey, ref));
}

export async function linkDocNodeAction(projectKey: string, ref: string, nodeId: string, unlink = false) {
  const { actor } = await requireHuman();
  return wrap(() => svc.linkDocNode(actor, projectKey, ref, nodeId, unlink));
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

// ───────── repositories (WH-68) ─────────

export async function listRepositoriesAction(projectKey: string) {
  const { actor } = await requireHuman();
  return wrap(() => svc.listRepositories(actor, projectKey));
}

export async function createRepositoryAction(projectKey: string, input: svc.RepositoryInput) {
  const { actor } = await requireHuman();
  const res = await wrap(() => svc.createRepository(actor, projectKey, input));
  revalidatePath(`/p/${projectKey}/repos`);
  return res;
}

/** The "Connect" button next to a repository GitHub lists for the team's installation (owners only; checked in the service). */
export async function connectGithubRepositoryAction(fd: FormData): Promise<void> {
  const { actor } = await requireHuman();
  const projectKey = String(fd.get("project") ?? "");
  const res = await wrap(() =>
    gh.connectGithubRepository(
      actor,
      projectKey,
      { installationId: String(fd.get("installationId") ?? ""), githubRepoId: String(fd.get("repoId") ?? ""), role: String(fd.get("role") ?? "").trim() || "code", pathLimit: String(fd.get("pathLimit") ?? "").trim() || null },
      github()?.api ?? null,
    ),
  );
  revalidatePath(`/p/${projectKey}/repos`);
  redirect(`/p/${encodeURIComponent(projectKey)}/repos?${res.ok ? "github=repo_connected" : `github_error=connect_failed&github_msg=${encodeURIComponent(res.error)}`}`);
}

export async function updateRepositoryAction(projectKey: string, id: string, patch: Partial<svc.RepositoryInput>) {
  const { actor } = await requireHuman();
  const res = await wrap(() => svc.updateRepository(actor, projectKey, id, patch));
  revalidatePath(`/p/${projectKey}/repos`);
  return res;
}

export async function retireRepositoryAction(projectKey: string, id: string) {
  const { actor } = await requireHuman();
  const res = await wrap(() => svc.retireRepository(actor, projectKey, id));
  revalidatePath(`/p/${projectKey}/repos`);
  return res;
}

/**
 * Browse a connected GitHub repository's file tree for the doc anchor picker (WH-82). Read-only;
 * team isolation comes from `svc.listRepositories`, which resolves the project through `getProject`
 * (team-scoped) and only returns rows belonging to it — so a `repositoryId` from another team's
 * project never matches and this returns "not_found" rather than another team's tree.
 */
export async function browseRepoTreeAction(projectKey: string, repositoryId: string) {
  const { actor } = await requireHuman();
  return wrap(async () => {
    const repos = await svc.listRepositories(actor, projectKey);
    const repo = repos.find((r) => r.id === repositoryId);
    if (!repo) throw new svc.ServiceError("not_found", `Repository "${repositoryId}" not found`);
    if (repo.provider !== "github" || !repo.githubInstallationId || !repo.githubRepoId) {
      throw new svc.ServiceError("invalid", "This repository is not connected to GitHub");
    }
    const gh2 = github();
    if (!gh2) throw new svc.ServiceError("invalid", "GitHub is not set up on this server");
    const { files, truncated } = await gh2.api.treeAt(repo.githubInstallationId, repo.githubRepoId, repo.defaultBranch || "main");
    return { files: files.map((f) => ({ path: f.path })), truncated };
  });
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
  const { resolveDraft } = await import("@wheelhouse/core/lib/sync");
  return wrap(() => resolveDraft(actor, projectKey, draftId, action));
}

export async function resolveDocDraftAction(projectKey: string, draftId: string, action: "publish" | "discard") {
  const { actor } = await requireHuman();
  const { resolveDocDraft } = await import("@wheelhouse/core/lib/sync");
  return wrap(() => resolveDocDraft(actor, projectKey, draftId, action));
}
