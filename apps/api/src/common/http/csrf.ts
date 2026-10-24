import crypto from "node:crypto";

/**
 * CSRF protection for the web app's API (/api/app/*), which replaces what Next gave server actions for free.
 *
 * Every state-changing request (POST, PUT, PATCH, DELETE) must pass two checks:
 *  1. Origin: if the browser says where the request came from (the Origin header, else the Referer), that must be this
 *     site. A request with neither is allowed to continue to check 2 (curl, tests, native clients), but a browser always sends
 *     Origin on a cross-site POST, so a forged one is stopped here.
 *  2. Token: the `X-CSRF-Token` header must equal the token derived from the session cookie, or the literal "anonymous" when
 *     there is no session (sign in, sign up). A page on another site cannot send a custom header without a CORS preflight,
 *     which this API never approves, and cannot read the token from a response either.
 * The session cookie is also SameSite=Lax, which is the first line of defence. GET, HEAD and OPTIONS are never checked, so
 * no GET endpoint may change anything.
 */
export const CSRF_HEADER = "x-csrf-token";
export const ANONYMOUS_CSRF = "anonymous";

/** The token for a session: an HMAC keyed by the session cookie's own secret value, so it is bound to that session. */
export const csrfToken = (sessionToken: string) => crypto.createHmac("sha256", sessionToken).update("wheelhouse:csrf:v1").digest("base64url");

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type CsrfInput = {
  method: string;
  origin?: string | null;
  referer?: string | null;
  /** The Host header: this site as the browser addressed it. */
  host?: string | null;
  tokenHeader?: string | null;
  sessionToken?: string | null;
  /** Extra origins to trust, e.g. the public URL (APP_URL) and a dev server (APP_ORIGINS). */
  allowedOrigins: string[];
};

export type CsrfVerdict = { ok: true } | { ok: false; reason: "origin" | "token" };

const refererOrigin = (referer?: string | null) => {
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return "null"; // present but unreadable: not trusted
  }
};

function originAllowed(origin: string, host: string | null | undefined, allowed: string[]) {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false; // includes the literal "null" that sandboxed and privacy-mode pages send
  }
  if (allowed.includes(url.origin)) return true;
  return !!host && url.host.toLowerCase() === host.toLowerCase();
}

const sameValue = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function checkCsrf(i: CsrfInput): CsrfVerdict {
  if (!UNSAFE.has(i.method.toUpperCase())) return { ok: true };
  const from = i.origin?.trim() ? i.origin.trim() : refererOrigin(i.referer);
  if (from && !originAllowed(from, i.host, i.allowedOrigins)) return { ok: false, reason: "origin" };
  const expected = i.sessionToken ? csrfToken(i.sessionToken) : ANONYMOUS_CSRF;
  if (!i.tokenHeader || !sameValue(i.tokenHeader, expected)) return { ok: false, reason: "token" };
  return { ok: true };
}

/** APP_URL and APP_ORIGINS (comma separated) as origins. */
export function configuredOrigins(env: Record<string, string | undefined> = process.env): string[] {
  const out: string[] = [];
  for (const raw of [env.APP_URL, ...(env.APP_ORIGINS ?? "").split(",")]) {
    const v = raw?.trim();
    if (!v) continue;
    try {
      out.push(new URL(v).origin);
    } catch {
      /* ignore a malformed entry */
    }
  }
  return out;
}

export class CsrfError extends Error {
  constructor(public reason: "origin" | "token") {
    super(reason === "origin" ? "Cross-site request refused" : "Missing or invalid CSRF token");
  }
}
