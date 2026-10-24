/**
 * The auth module's error classes. Plain on purpose: `lib/api-errors.ts`, the stream and the MCP endpoint match on them with
 * instanceof, so they must be importable without loading the services.
 */

/** Shown to members of a suspended workspace and returned to its API keys. Deliberately says nothing about why. */
export const WORKSPACE_SUSPENDED_MESSAGE = "This workspace has been suspended. Contact the administrator.";

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

export class AccountError extends Error {
  constructor(
    public code: "invalid" | "conflict" | "unauthorized" | "forbidden" | "signup_closed" | "team_suspended" | "rate_limited",
    message: string,
    public opts: { fields?: Record<string, string>; retryAfter?: number } = {},
  ) {
    super(message);
  }
  get status() {
    return { invalid: 400, conflict: 409, unauthorized: 401, forbidden: 403, signup_closed: 403, team_suspended: 403, rate_limited: 429 }[this.code];
  }
  get fields() {
    return this.opts.fields;
  }
  get retryAfter() {
    return this.opts.retryAfter;
  }
}

export const INVITE_INVALID = "This invite link is invalid or has expired.";

export type InviteFailureReason = "invalid" | "workspace_full" | "account_exists";

/** Acceptance failure. `message` is always the generic text, whatever the reason. */
export class InviteFailure extends Error {
  constructor(public reason: InviteFailureReason) {
    super(INVITE_INVALID);
  }
}

/** A problem the person issuing an invite can be told about (they are signed in and authorised). */
export class InviteError extends Error {
  constructor(
    public code: "invalid" | "forbidden" | "conflict" | "workspace_full" | "not_found" | "weak_password",
    message: string,
  ) {
    super(message);
  }
}

export class AdminError extends Error {
  constructor(public code: "forbidden" | "not_found" | "invalid" | "conflict", message: string) {
    super(message);
  }
}
