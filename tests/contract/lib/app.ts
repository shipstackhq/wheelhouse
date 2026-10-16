import { BASE, call, fx, type CallOpts, type Res } from "./http";

/** Helpers for the web app's API (/api/app): a browser-like session with the CSRF header handled. */
export const ORIGIN = new URL(BASE).origin;

export type Sess = { cookie: string | null; csrf: string };
export const anon = (): Sess => ({ cookie: null, csrf: "anonymous" });

/** The session a sign-in or sign-up response started: the cookie value and the CSRF token from the body. */
export function sessionFrom(r: Res): Sess {
  const set = r.cookies.find((c) => c.startsWith("wh_session="));
  if (!set || !r.json?.csrfToken) throw new Error(`no session started: ${r.status} ${r.text.slice(0, 200)}`);
  return { cookie: decodeURIComponent(set.split(";")[0].slice("wh_session=".length)), csrf: r.json.csrfToken };
}

/** A same-site, browser-like call: Origin is this site and the CSRF token is sent. Override either to test a refusal. */
export function app(method: string, path: string, s: Sess = anon(), o: CallOpts & { origin?: string | null; csrf?: string | null } = {}) {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  const origin = o.origin === undefined ? ORIGIN : o.origin;
  if (origin) headers.origin = origin;
  const csrf = o.csrf === undefined ? s.csrf : o.csrf;
  if (csrf) headers["x-csrf-token"] = csrf;
  return call(path, { ...o, method, headers, cookie: s.cookie, body: o.body });
}

export const login = (email: string, password: string = fx.password, o: CallOpts = {}) => app("POST", "/api/app/auth/login", anon(), { ...o, body: { email, password } });

export async function signIn(email: string): Promise<Sess> {
  const r = await login(email);
  return sessionFrom(r);
}

let n = 0;
export const newEmail = () => `web-${Date.now().toString(36)}-${++n}@example.test`;
