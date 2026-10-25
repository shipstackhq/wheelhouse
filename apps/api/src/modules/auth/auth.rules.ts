import { minutes } from "../../common/rate-limit";
import { canManagePeople } from "../../common/roles";
import { ServiceError } from "../../common/service-error";
import type { WorkspaceRole } from "../../db/schema";
import { AccountError, AdminError } from "./auth-errors";
import { isInstanceAdmin } from "./auth-policy";

/**
 * The auth module's rules that need no database: who may manage people, who may administer the instance, the shape of an email and
 * of an invite token, and the readers of the request bodies the web app sends. The services decide with them; the tests cover them.
 */

/** Who is issuing an invite: the signed-in person and their workspace role. */
export type Issuer = { userId: string; email: string; workspaceId: string; role: WorkspaceRole };

/** The part of the signed-in person an issuer is made from. */
export const issuerOf = (h: { user: { id: string; email: string }; workspace: { id: string }; membership: { role: WorkspaceRole } }): Issuer => ({
  userId: h.user.id,
  email: h.user.email,
  workspaceId: h.workspace.id,
  role: h.membership.role,
});

export function requireManager(role: WorkspaceRole) {
  if (!canManagePeople(role)) throw new ServiceError("forbidden", "Only workspace owners and admins can do that");
}

export function requireAdmin(email: string) {
  if (!isInstanceAdmin(email)) throw new AdminError("forbidden", "Only instance admins can do that");
}

/** Too many attempts: the 429 the sign-in and invite pages show, with the minutes to wait. */
export const tooMany = (retryAfter: number) =>
  new AccountError("rate_limited", `Too many attempts. Try again in ${minutes(retryAfter)} minute${minutes(retryAfter) === 1 ? "" : "s"}.`, { retryAfter });

export const emailOk = (e: string) => e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
export const normalizeEmail = (e: string) => e.trim().toLowerCase();

/** An invite token is 32 random bytes, base64url: anything else is not a token and never reaches the database. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** A unique-key violation however the driver wraps it. */
export const isUniqueViolation = (e: unknown) => {
  const x = e as { code?: string; cause?: { code?: string }; message?: string };
  return x?.code === "23505" || x?.cause?.code === "23505" || /duplicate key|unique constraint/i.test(x?.message ?? "");
};

/** `[{ team: "WH", role: "editor" }, ...]` from a request body; anything else is dropped here and judged for real in createInvite. */
export function parseGrants(v: unknown): { team: string; role: "admin" | "editor" | "viewer" }[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((g) => {
    const o = g as { team?: unknown; role?: unknown };
    const role = o?.role === "admin" || o?.role === "editor" || o?.role === "viewer" ? o.role : null;
    return typeof o?.team === "string" && o.team && role ? [{ team: o.team, role }] : [];
  });
}

/** "a, B ,c" or ["a", "B"] to ["a", "b", "c"]: lower case, trimmed, empties dropped. */
export function parseTags(v: unknown): string[] {
  const parts = Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",") : [];
  return parts.map((t) => t.trim().toLowerCase()).filter(Boolean);
}
