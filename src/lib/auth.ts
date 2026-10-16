import "server-only";
import crypto from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@wheelhouse/core/db";
import { signupOpen } from "@wheelhouse/core/lib/auth-policy";
import { clientIp } from "@wheelhouse/core/lib/rate-limit";
import { actorForKey, AuthError, sha256, userForSessionToken, type Actor } from "@wheelhouse/core/lib/access";

// Everything that decides who may come in lives in access.ts (testable without Next.js); re-exported so the rest
// of the app keeps importing it from here.
export {
  actorForKey,
  AuthError,
  RateLimitError,
  SuspendedError,
  TEAM_SUSPENDED_MESSAGE,
  sha256,
  userForSessionToken,
  userTeamSuspended,
  type Actor,
} from "@wheelhouse/core/lib/access";

const COOKIE = "wh_session";
const SESSION_DAYS = 30;

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

export const hashPassword = (pw: string) => bcrypt.hash(pw, 10);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

/** Whether the signup page and action are open (see auth-policy.ts). */
export async function signupAllowed() {
  const db = await getDb();
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.users);
  return signupOpen({ allowSignup: process.env.ALLOW_SIGNUP, nodeEnv: process.env.NODE_ENV, userCount: n });
}

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
  return userForSessionToken(token);
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

/**
 * For /api/v1 and /mcp. Accepts `Authorization: Bearer wh_…` (agents)
 * or a session cookie (humans hitting the API from the browser).
 */
export async function actorFromRequest(): Promise<Actor> {
  const h = await headers();
  const auth = h.get("authorization");
  if (auth?.startsWith("Bearer ")) return actorForKey(auth.slice(7).trim(), clientIp(h));
  const user = await currentUser();
  if (!user) throw new AuthError("Not authenticated");
  const m = await currentMembership(user.id);
  if (!m) throw new AuthError("No team");
  return { kind: "human", id: user.id, name: user.name, teamId: m.team.id };
}
