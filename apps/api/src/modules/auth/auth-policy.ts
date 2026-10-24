/**
 * Who may create a new workspace by signing up.
 *  - ALLOW_SIGNUP=true  → open.
 *  - ALLOW_SIGNUP=false → closed, except for the very first account, so a fresh install can be claimed.
 *  - unset              → open outside production, closed in production.
 */
export function signupOpen(opts: { allowSignup?: string; nodeEnv?: string; userCount: number }): boolean {
  if (opts.userCount === 0) return true;
  const v = opts.allowSignup?.trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  return opts.nodeEnv !== "production";
}

/** New passwords must be at least this long (WH-49 raised it from 8). */
export const MIN_PASSWORD_LENGTH = 12;
/** bcrypt only uses the first 72 bytes, so anything longer would be silently truncated. */
export const MAX_PASSWORD_BYTES = 72;

/** A user-facing problem with a new password, or null when it is acceptable. */
export function passwordProblem(pw: string): string | null {
  if (pw.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (new TextEncoder().encode(pw).length > MAX_PASSWORD_BYTES) return `Password must be at most ${MAX_PASSWORD_BYTES} bytes long`;
  return null;
}

const positiveInt = (v: string | undefined, fallback: number) => {
  const n = Number(v?.trim());
  return Number.isInteger(n) && n >= 1 ? n : fallback;
};

/** Seats per workspace, owner included; pending invites count (MAX_WORKSPACE_MEMBERS, default 5). */
export const maxWorkspaceMembers = (raw = process.env.MAX_WORKSPACE_MEMBERS) => positiveInt(raw, 5);

/** How long an invite link works, in hours (INVITE_TTL_HOURS, default 7 days). */
export const inviteTtlHours = (raw = process.env.INVITE_TTL_HOURS) => positiveInt(raw, 168);

/** Instance admins may create invites that start a brand new workspace (ADMIN_EMAILS, comma-separated). */
export const adminEmails = (raw = process.env.ADMIN_EMAILS) =>
  (raw ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

export const isInstanceAdmin = (email: string, raw = process.env.ADMIN_EMAILS) => adminEmails(raw).includes(email.trim().toLowerCase());
