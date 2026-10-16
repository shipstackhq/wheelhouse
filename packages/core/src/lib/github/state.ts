import crypto from "node:crypto";

/**
 * The `state` sent to GitHub when someone starts connecting, and checked when GitHub sends them back. It carries who
 * started it and for which project, expires in ten minutes, and is signed, so a link someone else made (or an old one)
 * cannot be replayed into another person's session. A cookie holding the nonce ties it to the same browser.
 */
export const STATE_TTL_MS = 10 * 60_000;
/** The cookie that holds the nonce, scoped to the GitHub endpoints only. */
export const STATE_COOKIE = "wh_gh_state";
export const STATE_COOKIE_PATH = "/api/github";

export type ConnectState = { user: string; project: string; nonce: string; exp: number };

const sign = (secret: string, body: string) => crypto.createHmac("sha256", secret).update(body).digest("base64url");

export function makeState(secret: string, s: { user: string; project: string }, now = Date.now()): { state: string; nonce: string } {
  const nonce = crypto.randomBytes(16).toString("base64url");
  const body = Buffer.from(JSON.stringify({ user: s.user, project: s.project, nonce, exp: now + STATE_TTL_MS } satisfies ConnectState)).toString("base64url");
  return { state: `${body}.${sign(secret, body)}`, nonce };
}

/** The state if it is genuine and fresh, otherwise null (the reason is deliberately not given). */
export function readState(secret: string, state: string | null | undefined, now = Date.now()): ConnectState | null {
  if (!state) return null;
  const [body, sig] = state.split(".");
  if (!body || !sig) return null;
  const expected = sign(secret, body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<ConnectState>;
    if (typeof s.user !== "string" || typeof s.project !== "string" || typeof s.nonce !== "string" || typeof s.exp !== "number") return null;
    return s.exp > now ? (s as ConnectState) : null;
  } catch {
    return null;
  }
}
