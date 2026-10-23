import { AuthError } from "./access";
import { AccountError } from "./accounts";
import { InviteError, InviteFailure, INVITE_INVALID } from "./invites";
import { ServiceError } from "./service";
import { AdminError } from "./workspaces-admin";

/** How a failure is answered over HTTP: shared by every host so the REST and MCP error shapes cannot drift apart. */
export type Failure = { status: number; body: unknown; headers?: Record<string, string> };

/** /api/v1: `{ error: { code, message, details? } }`. */
export function v1Failure(e: unknown): Failure {
  if (e instanceof AuthError)
    return {
      status: e.status,
      body: { error: { code: e.status === 429 ? "rate_limited" : e.status === 403 ? "team_suspended" : "unauthorized", message: e.message } },
      headers: e.retryAfter ? { "Retry-After": String(e.retryAfter) } : undefined,
    };
  if (e instanceof ServiceError) return { status: e.status, body: { error: { code: e.code, message: e.message, details: e.details } } };
  console.error("[api]", e);
  return { status: 500, body: { error: { code: "internal", message: "Internal error" } } };
}

/** /mcp, when authentication fails: a JSON-RPC error, with the Bearer challenge on a 401. */
export function mcpAuthFailure(e: AuthError): Failure {
  return {
    status: e.status,
    body: { jsonrpc: "2.0", id: null, error: { code: -32001, message: e.message } },
    headers: e.retryAfter ? { "Retry-After": String(e.retryAfter) } : e.status === 401 ? { "WWW-Authenticate": 'Bearer realm="wheelhouse"' } : undefined,
  };
}

/**
 * The web app's API (/api/app/*): the same `{ error: { code, message, details? } }` as /api/v1, plus the account errors
 * (sign in, sign up). A field-level problem is `details.fields` = `{ fieldName: message }`; an optimistic-lock conflict is
 * code "conflict" with the current state in `details.current`.
 */
export function appFailure(e: unknown): Failure {
  if (e instanceof AccountError)
    return {
      status: e.status,
      body: { error: { code: e.code, message: e.message, details: e.fields ? { fields: e.fields } : undefined } },
      headers: e.retryAfter ? { "Retry-After": String(e.retryAfter) } : undefined,
    };
  // Invites and the instance admin's workspace controls have their own error classes (the Next actions show their messages).
  if (e instanceof InviteError) {
    const status = { invalid: 400, weak_password: 400, forbidden: 403, conflict: 409, workspace_full: 409, not_found: 404 }[e.code];
    const code = e.code === "weak_password" ? "invalid" : e.code === "workspace_full" ? "conflict" : e.code;
    const details = e.code === "weak_password" ? { fields: { password: e.message } } : undefined;
    return { status, body: { error: { code, message: e.message, details } } };
  }
  // Every problem with the invite itself reads the same, so a link cannot be probed for why it failed.
  if (e instanceof InviteFailure) return { status: 400, body: { error: { code: "invalid", message: INVITE_INVALID } } };
  if (e instanceof AdminError) {
    const status = { forbidden: 403, not_found: 404, invalid: 400, conflict: 409 }[e.code];
    return { status, body: { error: { code: e.code, message: e.message } } };
  }
  return v1Failure(e);
}
