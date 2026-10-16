import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, createApiClient, type Me } from "./index";

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };
const me = (token: string): Me => ({ user: { id: "u1", name: "Ada", email: "ada@example.test" }, team: { id: "t1", name: "Ada's team" }, role: "owner", tags: ["eng"], isInstanceAdmin: false, csrfToken: token });

/** A scripted fetch: each call takes the next reply (a status and JSON body, plus optional headers). */
function script(replies: { status?: number; json?: unknown; text?: string; headers?: Record<string, string> }[]) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method!, url, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined });
    const r = replies.shift();
    assert.ok(r, `unexpected request ${init.method} ${url}`);
    const status = r.status ?? 200;
    return new Response(r.text ?? (r.json === undefined ? "" : JSON.stringify(r.json)), { status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { f, calls };
}

/** The ApiError a call fails with. */
const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof ApiError, `expected an ApiError, got ${e}`);
    return e;
  }
  return assert.fail("expected the call to fail");
};

describe("CSRF token handling", () => {
  test("reads send none; before sign-in a write sends 'anonymous'; after sign-in it sends the session's token", async () => {
    const s = script([{ json: { signupOpen: true } }, { json: me("tok-1") }, { json: { ok: true } }, { json: { ok: true } }]);
    const api = createApiClient({ fetch: s.f });
    await api.auth.options();
    assert.equal(s.calls[0].headers["x-csrf-token"], undefined);
    await api.auth.login({ email: "ada@example.test", password: "pw" });
    assert.equal(s.calls[1].headers["x-csrf-token"], "anonymous");
    assert.equal(api.post === undefined, false);
    await api.post("/api/app/things", { a: 1 });
    assert.equal(s.calls[2].headers["x-csrf-token"], "tok-1");
    await api.auth.logout();
    assert.equal(s.calls[3].headers["x-csrf-token"], "tok-1");
    assert.equal(api.me === undefined, false);
  });

  test("after logout the token goes back to 'anonymous'", async () => {
    const s = script([{ json: me("tok-1") }, { json: { ok: true } }, { json: me("tok-2") }]);
    const api = createApiClient({ fetch: s.f });
    await api.auth.login({ email: "a@b.c", password: "x" });
    await api.auth.logout();
    await api.auth.login({ email: "a@b.c", password: "x" });
    assert.equal(s.calls[2].headers["x-csrf-token"], "anonymous");
  });

  test("a stale token is refreshed once from /me and the request retried", async () => {
    const stale = { status: 403, json: { error: { code: "csrf_failed", message: "Missing or invalid CSRF token" } } };
    const s = script([{ json: me("old") }, stale, { json: me("new") }, { json: { done: true } }]);
    const api = createApiClient({ fetch: s.f });
    await api.auth.login({ email: "a@b.c", password: "x" });
    const out = await api.post<{ done: boolean }>("/api/app/things", { a: 1 });
    assert.deepEqual(out, { done: true });
    assert.deepEqual(s.calls.map((c) => `${c.method} ${c.url} ${c.headers["x-csrf-token"] ?? "-"}`), [
      "POST /api/app/auth/login anonymous",
      "POST /api/app/things old",
      "GET /api/app/me -",
      "POST /api/app/things new",
    ]);
  });

  test("if the session is gone the refresh falls back to 'anonymous', and a second refusal is an error, not a loop", async () => {
    const stale = { status: 403, json: { error: { code: "csrf_failed", message: "Missing or invalid CSRF token" } } };
    const s = script([{ json: me("old") }, stale, { status: 401, json: { error: { code: "unauthorized", message: "Not authenticated" } } }, stale]);
    const api = createApiClient({ fetch: s.f });
    await api.auth.login({ email: "a@b.c", password: "x" });
    await assert.rejects(api.post("/api/app/things"), (e: unknown) => e instanceof ApiError && e.code === "csrf_failed");
    assert.equal(s.calls.length, 4, "one retry only");
    assert.equal(s.calls[3].headers["x-csrf-token"], "anonymous");
  });

  test("a failed read is never retried", async () => {
    const s = script([{ status: 403, json: { error: { code: "csrf_failed", message: "x" } } }]);
    await assert.rejects(createApiClient({ fetch: s.f }).get("/api/app/things"));
    assert.equal(s.calls.length, 1);
  });
});

describe("errors", () => {
  test("the envelope becomes an ApiError with status, code, message, fields and retry delay", async () => {
    const s = script([
      { status: 400, json: { error: { code: "invalid", message: "Password must be at least 12 characters", details: { fields: { password: "Password must be at least 12 characters" } } } } },
      { status: 429, json: { error: { code: "rate_limited", message: "Too many attempts. Try again in 5 minutes." } }, headers: { "retry-after": "300" } },
    ]);
    const api = createApiClient({ fetch: s.f });
    const e1 = await failure(api.auth.signup({ name: "a", email: "a@b.c", password: "short" }));
    assert.ok(e1 instanceof ApiError);
    assert.equal(e1.status, 400);
    assert.equal(e1.code, "invalid");
    assert.deepEqual(e1.fields, { password: "Password must be at least 12 characters" });
    const e2 = await failure(api.auth.login({ email: "a@b.c", password: "x" }));
    assert.equal(e2.code, "rate_limited");
    assert.equal(e2.retryAfter, 300);
    assert.equal(e2.fields, undefined);
  });

  test("a conflict carries what the server has now", async () => {
    const s = script([{ status: 409, json: { error: { code: "conflict", message: "TT-1 was changed since you read it", details: { current: { version: 4 } } } } }]);
    const e = await failure(createApiClient({ fetch: s.f }).patch("/api/app/tickets/TT-1", { title: "x" }));
    assert.ok(e.isConflict);
    assert.deepEqual(e.current, { version: 4 });
  });

  test("an unreadable failure still produces a useful error", async () => {
    const s = script([{ status: 502, text: "<html>Bad gateway</html>" }, { status: 500, text: "" }]);
    const api = createApiClient({ fetch: s.f });
    const e1 = await failure(api.get("/api/app/x"));
    assert.equal(e1.status, 502);
    assert.equal(e1.code, "http_error");
    assert.match(e1.message, /Bad gateway/);
    const e2 = await failure(api.get("/api/app/y"));
    assert.equal(e2.status, 500);
    assert.ok(e2.message.length > 0);
  });
});

describe("me()", () => {
  test("is null when signed out, the person when signed in, and other failures still throw", async () => {
    const s = script([{ status: 401, json: { error: { code: "unauthorized", message: "Not authenticated" } } }, { json: me("t") }, { status: 500, json: { error: { code: "internal", message: "Internal error" } } }]);
    const api = createApiClient({ fetch: s.f });
    assert.equal(await api.me(), null);
    assert.equal((await api.me())?.user.name, "Ada");
    await assert.rejects(api.me(), (e: unknown) => e instanceof ApiError && e.status === 500);
  });
});

describe("requests", () => {
  test("a base URL is a prefix, JSON bodies are JSON, and projects.list unwraps the list", async () => {
    const s = script([{ json: { projects: [{ id: "1", key: "WH", name: "Wheelhouse", description: "", createdAt: "2026-10-16T00:00:00Z" }] } }]);
    const api = createApiClient({ baseUrl: "https://wh.example/", fetch: s.f });
    const list = await api.projects.list();
    assert.equal(s.calls[0].url, "https://wh.example/api/app/projects");
    assert.equal(s.calls[0].headers.accept, "application/json");
    assert.deepEqual(list.map((p) => p.key), ["WH"]);
  });
});
