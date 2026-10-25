/** The error every service function throws for a caller's mistake; `status` is what REST and MCP answer with. */
export class ServiceError extends Error {
  constructor(
    public code: "not_found" | "conflict" | "invalid" | "forbidden",
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
  get status() {
    return { not_found: 404, conflict: 409, invalid: 400, forbidden: 403 }[this.code];
  }
}
