import crypto from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb, schema } from "../db";
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
  workspaceId: string;
  /**
   * Set only by Wheelhouse itself for work it does on a workspace's behalf, such as handling a GitHub webhook. A system actor is
   * not a person and not a team member: like an agent key it reaches every team of its own workspace and nothing outside it.
   */
  system?: true;
  /** Agents only: the client session making the call (Claude Code session_id), when the call names one. */
  sessionId?: string;
};

/**
 * Shown to members of a suspended workspace and returned to its API keys. Deliberately says nothing about why.
 */
export const WORKSPACE_SUSPENDED_MESSAGE = "This workspace has been suspended. Contact the administrator.";

/**
 * Whether every workspace the user belongs to is suspended by an instance admin (WH-52). Someone in several workspaces is only locked
 * out when all of them are; one suspended workspace is simply not offered to them.
 */
export async function userWorkspaceSuspended(userId: string) {
  const db = await getDb();
  const rows = await db
    .select({ at: schema.workspaces.suspendedAt })
    .from(schema.memberships)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.memberships.workspaceId))
    .where(eq(schema.memberships.userId, userId));
  return rows.length > 0 && rows.every((r) => !!r.at);
}

/**
 * The signed-in user behind a session cookie value, with the workspace the session is working in (or null for "their first"),
 * or null when signed out. A person whose every workspace is suspended counts as signed out even if a session row still exists, so
 * every page, action and API call refuses them from this one place.
 */
export async function sessionForToken(token: string, now = new Date()) {
  const db = await getDb();
  const [row] = await db
    .select({ user: schema.users, activeWorkspaceId: schema.sessions.activeWorkspaceId })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.id, sha256(token)), gt(schema.sessions.expiresAt, now)));
  if (!row) return null;
  if (await userWorkspaceSuspended(row.user.id)) return null;
  return row;
}

export async function userForSessionToken(token: string, now = new Date()) {
  return (await sessionForToken(token, now))?.user ?? null;
}

export class AuthError extends Error {
  status = 401;
  retryAfter?: number;
}

/** A valid key or user whose workspace an instance admin has suspended: 403, not 401, so clients stop retrying. */
export class SuspendedError extends AuthError {
  status = 403;
  constructor() {
    super(WORKSPACE_SUSPENDED_MESSAGE);
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
    .select({ key: schema.apiKeys, suspendedAt: schema.workspaces.suspendedAt })
    .from(schema.apiKeys)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.apiKeys.workspaceId))
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
  return { kind: "agent", id: row.key.id, name: row.key.name, workspaceId: row.key.workspaceId };
}

