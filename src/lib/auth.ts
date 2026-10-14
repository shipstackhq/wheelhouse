import "server-only";
import crypto from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import bcrypt from "bcryptjs";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { signupOpen } from "./auth-policy";
import { clientIp, rateLimit } from "./rate-limit";

const COOKIE = "wh_session";
const SESSION_DAYS = 30;

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

export const hashPassword = (pw: string) => bcrypt.hash(pw, 10);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

/** Whether the signup page and action are open (see auth-policy.ts). */
export async function signupAllowed() {
  const db = await getDb();
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.users);
  return signupOpen({ allowSignup: process.env.ALLOW_SIGNUP, nodeEnv: process.env.NODE_ENV, userCount: n });
}

/** Who performed an action. Every mutation is attributed to one of these. */
export type Actor = {
  kind: "human" | "agent";
  id: string; // user id or api key id
  name: string;
  teamId: string;
};

export async function createSession(userId: string) {
  const db = await getDb();
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 864e5);
  await db.insert(schema.sessions).values({ id: sha256(token), userId, expiresAt });
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) {
    const db = await getDb();
    await db.delete(schema.sessions).where(eq(schema.sessions.id, sha256(token)));
  }
  jar.delete(COOKIE);
}

export async function currentUser() {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const db = await getDb();
  const [row] = await db
    .select({ user: schema.users })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.id, sha256(token)), gt(schema.sessions.expiresAt, new Date())));
  return row?.user ?? null;
}

/** MVP: one team per user (the first membership). */
export async function currentMembership(userId: string) {
  const db = await getDb();
  const [m] = await db
    .select({ membership: schema.memberships, team: schema.teams })
    .from(schema.memberships)
    .innerJoin(schema.teams, eq(schema.teams.id, schema.memberships.teamId))
    .where(eq(schema.memberships.userId, userId))
    .limit(1);
  return m ?? null;
}

/** For pages + server actions. Redirects to /login when signed out. */
export async function requireHuman() {
  const user = await currentUser();
  if (!user) redirect("/login");
  const m = await currentMembership(user.id);
  if (!m) redirect("/login");
  const actor: Actor = { kind: "human", id: user.id, name: user.name, teamId: m.team.id };
  return { user, team: m.team, membership: m.membership, actor };
}

export class AuthError extends Error {
  status = 401;
  retryAfter?: number;
}

export class RateLimitError extends AuthError {
  status = 429;
  constructor(retryAfter: number) {
    super("Too many requests");
    this.retryAfter = retryAfter;
  }
}

// Failed key attempts per client address, and steady-state calls per valid key.
const BAD_KEY_LIMIT = 30;
const BAD_KEY_WINDOW_MS = 60_000;
const KEY_CALL_LIMIT = 600;
const KEY_CALL_WINDOW_MS = 60_000;

/**
 * For /api/v1 and /mcp. Accepts `Authorization: Bearer wh_…` (agents)
 * or a session cookie (humans hitting the API from the browser).
 */
export async function actorFromRequest(): Promise<Actor> {
  const h = await headers();
  const auth = h.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    const key = auth.slice(7).trim();
    const db = await getDb();
    const [row] = await db
      .select()
      .from(schema.apiKeys)
      .where(and(eq(schema.apiKeys.keyHash, sha256(key)), isNull(schema.apiKeys.revokedAt)));
    if (!row) {
      const r = rateLimit(`badkey:${clientIp(h)}`, BAD_KEY_LIMIT, BAD_KEY_WINDOW_MS);
      if (!r.ok) throw new RateLimitError(r.retryAfter);
      throw new AuthError("Invalid or revoked API key");
    }
    const used = rateLimit(`key:${row.id}`, KEY_CALL_LIMIT, KEY_CALL_WINDOW_MS);
    if (!used.ok) throw new RateLimitError(used.retryAfter);
    await db.update(schema.apiKeys).set({ lastUsedAt: new Date() }).where(eq(schema.apiKeys.id, row.id));
    return { kind: "agent", id: row.id, name: row.name, teamId: row.teamId };
  }
  const user = await currentUser();
  if (!user) throw new AuthError("Not authenticated");
  const m = await currentMembership(user.id);
  if (!m) throw new AuthError("No team");
  return { kind: "human", id: user.id, name: user.name, teamId: m.team.id };
}
