import { eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import { actorForKey, AuthError, userForSessionToken, type Actor } from "./access";

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
