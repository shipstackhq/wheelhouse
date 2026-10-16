/**
 * A typed client for the web app's API (/api/app, WH-93). Only `fetch`, so it runs in the browser and in tests.
 *
 *   const api = createApiClient();                       // same origin, as the React app is served
 *   const me = await api.me();                           // null when signed out
 *   await api.auth.login({ email, password });
 *   const projects = await api.projects.list();
 *
 * It does two things every caller would otherwise get wrong:
 *  - the CSRF token: sent as X-CSRF-Token on every state-changing request ("anonymous" before sign-in; the token from
 *    /me, sign-in or sign-up after), and refreshed once, transparently, if the server says it has gone stale;
 *  - errors: every failure becomes an ApiError with the status, the machine-readable `code`, a human `message`, field
 *    problems in `fields`, and for an optimistic-lock conflict the server's current copy in `current`.
 * The conventions behind it are in docs/ui-api.md.
 */

export type Role = "owner" | "member";

export type Me = {
  user: { id: string; name: string; email: string };
  team: { id: string; name: string };
  role: Role;
  isInstanceAdmin: boolean;
  /** Sent back as X-CSRF-Token on state-changing requests; the client does this for you. */
  csrfToken: string;
};

export type Project = { id: string; key: string; name: string; description: string; createdAt: string };

export type LoginInput = { email: string; password: string };
export type SignupInput = { name: string; email: string; password: string; team?: string };

/** Every failed request. `code` is stable and meant for code; `message` is meant for people. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    /** Seconds to wait, from Retry-After (rate limits). */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
  /** Problems with particular inputs, by field name, when the server found some. */
  get fields(): Record<string, string> | undefined {
    const f = (this.details as { fields?: unknown } | undefined)?.fields;
    return f && typeof f === "object" ? (f as Record<string, string>) : undefined;
  }
  /** On an optimistic-lock conflict (code "conflict"), what the server has now. */
  get current(): unknown {
    return (this.details as { current?: unknown } | undefined)?.current;
  }
  get isConflict() {
    return this.code === "conflict";
  }
  get isSignedOut() {
    return this.status === 401 && this.code === "unauthorized";
  }
}

export type ApiClientOptions = {
  /** Prefix for every path; empty for same-origin. */
  baseUrl?: string;
  /** Replace fetch, e.g. to add a cookie jar in tests. */
  fetch?: typeof fetch;
};

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ANONYMOUS = "anonymous";

export function createApiClient(options: ApiClientOptions = {}) {
  const base = (options.baseUrl ?? "").replace(/\/+$/, "");
  const doFetch = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  let csrf = ANONYMOUS;

  async function request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const m = method.toUpperCase();
    const unsafe = UNSAFE.has(m);
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (unsafe) headers["x-csrf-token"] = csrf;
    const res = await doFetch(base + path, { method: m, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin" });
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (res.ok) return json as T;

    const env = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    const retryAfter = Number(res.headers.get("retry-after"));
    const err = new ApiError(res.status, env?.code ?? "http_error", env?.message ?? (text.slice(0, 200) || res.statusText || `Request failed (${res.status})`), env?.details, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
    // A stale token (signed in or out elsewhere) is fixed once, invisibly. Never loop.
    if (err.code === "csrf_failed" && unsafe && !retried) {
      await refreshToken();
      return request<T>(method, path, body, true);
    }
    throw err;
  }

  async function refreshToken() {
    try {
      csrf = (await request<Me>("GET", "/api/app/me")).csrfToken;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) csrf = ANONYMOUS;
      else throw e;
    }
  }

  const adopt = (me: Me) => {
    csrf = me.csrfToken;
    return me;
  };

  return {
    /** Any endpoint, with the same CSRF and error handling. Use the named methods where there is one. */
    request,
    get: <T>(path: string) => request<T>("GET", path),
    post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
    put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
    patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
    delete: <T>(path: string) => request<T>("DELETE", path),

    /** The signed-in person, or null when signed out. */
    async me(): Promise<Me | null> {
      try {
        return adopt(await request<Me>("GET", "/api/app/me"));
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          csrf = ANONYMOUS;
          return null;
        }
        throw e;
      }
    },

    auth: {
      /** For a signed-out page: may it offer sign-up? */
      options: () => request<{ signupOpen: boolean }>("GET", "/api/app/auth/options"),
      login: async (input: LoginInput) => adopt(await request<Me>("POST", "/api/app/auth/login", input)),
      signup: async (input: SignupInput) => adopt(await request<Me>("POST", "/api/app/auth/signup", input)),
      logout: async () => {
        await request<{ ok: true }>("POST", "/api/app/auth/logout", {});
        csrf = ANONYMOUS;
      },
    },

    projects: {
      list: async () => (await request<{ projects: Project[] }>("GET", "/api/app/projects")).projects,
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
