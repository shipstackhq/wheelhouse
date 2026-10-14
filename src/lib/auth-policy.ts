/**
 * Who may create a new team by signing up.
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
