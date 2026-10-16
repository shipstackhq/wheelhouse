import { AuthError } from "./access";
import { ServiceError } from "./service";

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
