import "server-only";
import crypto from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { rateLimit } from "./rate-limit";

/**
 * Who is allowed in: session and API-key lookups, and the suspension check (WH-52). No Next.js request
 * APIs in here, so it can be unit-tested; auth.ts adds the cookie and header handling on top.
 */

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** Who performed an action. Every mutation is attributed to one of these. */
export type Actor = {
  kind: "human" | "agent";
  id: string; // user id or api key id
  name: string;
  teamId: string;
  /** Agents only: the client session making the call (Claude Code session_id), when the call names one. */
  sessionId?: string;
};

/**
 * Shown to members of a suspended team and returned to its API keys. Deliberately says nothing about why.
 */
export const TEAM_SUSPENDED_MESSAGE = "This team has been suspended. Contact the administrator.";

/** Whether the user belongs to a team an instance admin has suspended (WH-52). */
export async function userTeamSuspended(userId: string) {
  const db = await getDb();
  const [row] = await db
    .select({ at: schema.teams.suspendedAt })
    .from(schema.memberships)
    .innerJoin(schema.teams, eq(schema.teams.id, schema.memberships.teamId))
    .where(eq(schema.memberships.userId, userId))
    .limit(1);
  return !!row?.at;
}

/**
 * The signed-in user behind a session cookie value, or null. A member of a suspended team counts as signed
 * out even if a session row still exists, so every page, action and API call refuses them from this one place.
 */
export async function userForSessionToken(token: string, now = new Date()) {
  const db = await getDb();
  const [row] = await db
    .select({ user: schema.users })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.id, sha256(token)), gt(schema.sessions.expiresAt, now)));
  if (!row) return null;
  if (await userTeamSuspended(row.user.id)) return null;
  return row.user;
}


export class AuthError extends Error {
  status = 401;
  retryAfter?: number;
}

/** A valid key or user whose team an instance admin has suspended: 403, not 401, so clients stop retrying. */
export class SuspendedError extends AuthError {
  status = 403;
  constructor() {
    super(TEAM_SUSPENDED_MESSAGE);
  }
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

/** The agent behind an API key. `ip` only feeds the bad-key rate limit. */
export async function actorForKey(key: string, ip: string): Promise<Actor> {
  const db = await getDb();
  const [row] = await db
    .select({ key: schema.apiKeys, suspendedAt: schema.teams.suspendedAt })
    .from(schema.apiKeys)
    .innerJoin(schema.teams, eq(schema.teams.id, schema.apiKeys.teamId))
    .where(and(eq(schema.apiKeys.keyHash, sha256(key)), isNull(schema.apiKeys.revokedAt)));
  if (!row) {
    const r = rateLimit(`badkey:${ip}`, BAD_KEY_LIMIT, BAD_KEY_WINDOW_MS);
    if (!r.ok) throw new RateLimitError(r.retryAfter);
    throw new AuthError("Invalid or revoked API key");
  }
  if (row.suspendedAt) throw new SuspendedError();
  const used = rateLimit(`key:${row.key.id}`, KEY_CALL_LIMIT, KEY_CALL_WINDOW_MS);
  if (!used.ok) throw new RateLimitError(used.retryAfter);
  await db.update(schema.apiKeys).set({ lastUsedAt: new Date() }).where(eq(schema.apiKeys.id, row.key.id));
  return { kind: "agent", id: row.key.id, name: row.key.name, teamId: row.key.teamId };
}

