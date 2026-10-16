import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import { actorForKey, AuthError, sha256, userForSessionToken, type Actor } from "./access";

/**
 * Who is calling, from the raw credentials of a request. Framework-free so the Next app and the API share one
 * implementation; each reads the Authorization header and the cookie its own way and passes them in.
 */

/** The session cookie: its value is a random token, the database holds only its sha256 (a session survives a migration). */
export const SESSION_COOKIE = "wh_session";
export const SESSION_DAYS = 30;

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

/**
 * `Authorization: Bearer wh_...` (agents) wins over a session cookie (people using the API from the browser). Throws
 * AuthError (401), SuspendedError (403) or RateLimitError (429).
 */
export async function actorFromCredentials(c: { authorization?: string | null; sessionToken?: string | null; ip: string }): Promise<Actor> {
  if (c.authorization?.startsWith("Bearer ")) return actorForKey(c.authorization.slice(7).trim(), c.ip);
  const user = c.sessionToken ? await userForSessionToken(c.sessionToken) : null;
  if (!user) throw new AuthError("Not authenticated");
  const m = await currentMembership(user.id);
  if (!m) throw new AuthError("No team");
  return { kind: "human", id: user.id, name: user.name, teamId: m.team.id };
}

/**
 * The person behind a session cookie, with their team and membership, or null when signed out. Pages and routes that
 * are only for people (connecting GitHub, the live streams) use this; each host decides what "signed out" looks like.
 */
export async function humanFromSession(token: string | undefined | null) {
  const user = token ? await userForSessionToken(token) : null;
  if (!user) return null;
  const m = await currentMembership(user.id);
  if (!m) return null;
  const actor: Actor = { kind: "human", id: user.id, name: user.name, teamId: m.team.id };
  return { user, team: m.team, membership: m.membership, actor };
}

export type Human = NonNullable<Awaited<ReturnType<typeof humanFromSession>>>;

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

export const hashPassword = (pw: string) => bcrypt.hash(pw, 10);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

/**
 * Start a session: a random token goes in the cookie, only its sha256 is stored. The host sets the cookie (name
 * SESSION_COOKIE, httpOnly, SameSite=Lax, Secure in production, path /, expiring at `expiresAt`).
 */
export async function startSession(userId: string) {
  const db = await getDb();
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 864e5);
  await db.insert(schema.sessions).values({ id: sha256(token), userId, expiresAt });
  return { token, expiresAt };
}

/** End a session by its cookie value. Harmless if there is none or it is already gone. */
export async function endSession(token: string | undefined | null) {
  if (!token) return;
  const db = await getDb();
  await db.delete(schema.sessions).where(eq(schema.sessions.id, sha256(token)));
}
