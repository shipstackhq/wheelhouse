"use server";

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
} from "@/lib/auth";
import * as svc from "@/lib/service";

export type FormState = { error?: string; ok?: string; secret?: string } | undefined;

const emailOk = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

function fail(e: unknown): FormState {
  if (e instanceof svc.ServiceError) return { error: e.message };
  throw e;
}

// ───────── auth ─────────

export async function signup(_: FormState, fd: FormData): Promise<FormState> {
  const name = String(fd.get("name") ?? "").trim();
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  const password = String(fd.get("password") ?? "");
  const teamName = String(fd.get("team") ?? "").trim() || `${name}'s team`;
  if (!name || !emailOk(email)) return { error: "Enter your name and a valid email" };
  if (password.length < 8) return { error: "Password must be at least 8 characters" };

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
  const db = await getDb();
  const [u] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  if (!u || !(await verifyPassword(password, u.passwordHash))) return { error: "Invalid email or password" };
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

export async function addMember(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const { team } = await requireOwner();
    const name = String(fd.get("name") ?? "").trim();
    const email = String(fd.get("email") ?? "").trim().toLowerCase();
    const role = fd.get("role") === "owner" ? "owner" : "member";
    const tags = parseTags(String(fd.get("tags") ?? ""));
    if (!name || !emailOk(email)) return { error: "Name and valid email required" };
    const db = await getDb();
    const [existing] = await db.select().from(schema.users).where(eq(schema.users.email, email));
    if (existing) {
      const [m] = await db.select().from(schema.memberships).where(eq(schema.memberships.userId, existing.id));
      if (m) return { error: "That user already belongs to a team" };
      await db.insert(schema.memberships).values({ userId: existing.id, teamId: team.id, role, tags });
      revalidatePath("/team");
      return { ok: `Added ${email}` };
    }
    // No invite emails in MVP: generate a temporary password to share out-of-band.
    const temp = randomToken(9);
    await db.transaction(async (tx) => {
      const [u] = await tx.insert(schema.users).values({ email, name, passwordHash: await hashPassword(temp) }).returning();
      await tx.insert(schema.memberships).values({ userId: u.id, teamId: team.id, role, tags });
    });
    revalidatePath("/team");
    return { ok: `Added ${email}. Share this temporary password:`, secret: temp };
  } catch (e) {
    return fail(e);
  }
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
  if (next.length < 8) return { error: "New password must be at least 8 characters" };
  if (!(await verifyPassword(current, user.passwordHash))) return { error: "Current password is wrong" };
  const db = await getDb();
  await db.update(schema.users).set({ passwordHash: await hashPassword(next) }).where(eq(schema.users.id, user.id));
  return { ok: "Password updated" };
}

// ───────── api keys ─────────

export async function createApiKey(_: FormState, fd: FormData): Promise<FormState> {
  const { team, user } = await requireHuman();
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

export async function connectNodesAction(projectKey: string, from: string, to: string, label?: string) {
  const { actor } = await requireHuman();
  return wrap(() => svc.upsertEdge(actor, projectKey, { from, to, label }));
}

export async function deleteEdgeAction(projectKey: string, edgeId: string) {
  const { actor } = await requireHuman();
  return wrap(() => svc.deleteEdge(actor, projectKey, edgeId));
}
