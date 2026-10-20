import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, createApiClient, type Me } from "./index";

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };
const me = (token: string): Me => ({ user: { id: "u1", name: "Ada", email: "ada@example.test" }, workspace: { id: "t1", name: "Ada's workspace" }, role: "owner", tags: ["eng"], isInstanceAdmin: false, csrfToken: token });

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
    const e = await failure(createApiClient({ fetch: s.f }).patch("/api/app/issues/TT-1", { title: "x" }));
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
  test("a base URL is a prefix, JSON bodies are JSON, and teams.list unwraps the list", async () => {
    const s = script([{ json: { teams: [{ id: "1", key: "WH", name: "Wheelhouse", description: "", createdAt: "2026-10-16T00:00:00Z" }] } }]);
    const api = createApiClient({ baseUrl: "https://wh.example/", fetch: s.f });
    const list = await api.teams.list();
    assert.equal(s.calls[0].url, "https://wh.example/api/app/teams");
    assert.equal(s.calls[0].headers.accept, "application/json");
    assert.deepEqual(list.map((p) => p.key), ["WH"]);
  });
});

describe("the page endpoints (WH-95)", () => {
  const ok = { json: { ok: true } };
  /** One call each, in order: what the client sent. */
  const sent = async (run: (api: ReturnType<typeof createApiClient>) => Promise<unknown>, reply: { status?: number; json?: unknown } = ok) => {
    const s = script([{ json: me("tok") }, reply]);
    const api = createApiClient({ fetch: s.f });
    await api.me();
    await run(api);
    const { method, url, body } = s.calls[1];
    return { method, url, body };
  };

  test("workspace: overview is a read; a member change is a PATCH with the id escaped; removal is a DELETE; the member comes out of the envelope", async () => {
    assert.deepEqual(await sent((a) => a.workspace.overview(), { json: { workspace: {} } }), { method: "GET", url: "/api/app/workspace", body: undefined });
    const patch = await sent((a) => a.workspace.updateMember("a b/c", { role: "owner", tags: ["x"] }), { json: { member: {} } });
    assert.deepEqual(patch, { method: "PATCH", url: "/api/app/workspace/members/a%20b%2Fc", body: { role: "owner", tags: ["x"] } });
    assert.deepEqual(await sent((a) => a.workspace.removeMember("u1")), { method: "DELETE", url: "/api/app/workspace/members/u1", body: undefined });
    const s = script([{ json: { member: { userId: "u1", tags: ["x"] } } }]);
    assert.deepEqual(await createApiClient({ fetch: s.f }).workspace.updateMember("u1", { role: "member", tags: "x" }), { userId: "u1", tags: ["x"] });
  });

  test("password: POST /me/password with both passwords", async () => {
    assert.deepEqual(await sent((a) => a.changePassword({ current: "old", next: "new" })), { method: "POST", url: "/api/app/me/password", body: { current: "old", next: "new" } });
  });

  test("keys: create sends only the name and hands back the secret; revoke and capability use the key's id", async () => {
    const s = script([{ status: 201, json: { key: { id: "k1" }, secret: "wh_secret" } }]);
    const made = await createApiClient({ fetch: s.f }).keys.create("CI");
    assert.deepEqual(s.calls[0].body, { name: "CI" });
    assert.equal(made.secret, "wh_secret");
    assert.deepEqual(await sent((a) => a.keys.revoke("k 1")), { method: "DELETE", url: "/api/app/keys/k%201", body: undefined });
    assert.deepEqual(await sent((a) => a.keys.setDocsWrite("k1", true), { json: { key: { id: "k1", canWriteDocs: true } } }), { method: "PATCH", url: "/api/app/keys/k1", body: { docsWrite: true } });
    assert.deepEqual(await sent((a) => a.keys.setTeams("k1", ["AA", "BB"]), { json: { key: { id: "k1", teams: [] } } }), { method: "PATCH", url: "/api/app/keys/k1", body: { teams: ["AA", "BB"] } });
    const scoped = script([{ status: 201, json: { key: { id: "k2" }, secret: "wh_s" } }]);
    await createApiClient({ fetch: scoped.f }).keys.create("CI", ["AA"]);
    assert.deepEqual(scoped.calls[0].body, { name: "CI", teams: ["AA"] });
    assert.deepEqual(await sent((a) => a.agents.page(), { json: { keys: [], setup: {} } }), { method: "GET", url: "/api/app/agents", body: undefined });
    assert.deepEqual(await sent((a) => a.agents.markAllSeen({ keyId: "k1" })), { method: "POST", url: "/api/app/agents/mark-all-seen", body: { keyId: "k1" } });
  });

  test("invites: list picks the kind and unwraps; peek is a POST so the token never sits in a URL; accept adopts the new session's token", async () => {
    const list = script([{ json: { invites: [{ id: "i1" }] } }]);
    assert.deepEqual(await createApiClient({ fetch: list.f }).invites.list("new_workspace"), [{ id: "i1" }]);
    assert.equal(list.calls[0].url, "/api/app/invites?kind=new_workspace");
    assert.deepEqual(await sent((a) => a.invites.create({ kind: "join_workspace", email: "x@y.z" }), { status: 201, json: {} }), { method: "POST", url: "/api/app/invites", body: { kind: "join_workspace", email: "x@y.z" } });
    const peek = await sent((a) => a.invites.peek("TOKEN"), { json: { invite: { email: "x@y.z" } } });
    assert.deepEqual(peek, { method: "POST", url: "/api/app/invites/peek", body: { token: "TOKEN" } });
    assert.ok(!peek.url.includes("TOKEN"));
    const accept = script([{ status: 201, json: me("fresh") }, { json: { ok: true } }]);
    const api = createApiClient({ fetch: accept.f });
    await api.invites.accept({ token: "T", name: "N", password: "p", confirm: "p" });
    assert.equal(accept.calls[0].headers["x-csrf-token"], "anonymous");
    await api.post("/api/app/x", {});
    assert.equal(accept.calls[1].headers["x-csrf-token"], "fresh", "signed in by accepting");
    assert.deepEqual(await sent((a) => a.invites.revoke("i1")), { method: "DELETE", url: "/api/app/invites/i1", body: undefined });
  });

  test("admin, teams and dashboard", async () => {
    assert.deepEqual(await sent((a) => a.admin.suspend("t1", { confirm: "Acme", reason: "x" }), { json: { name: "Acme", sessionsEnded: 0 } }), { method: "POST", url: "/api/app/admin/workspaces/t1/suspend", body: { confirm: "Acme", reason: "x" } });
    assert.deepEqual(await sent((a) => a.admin.restore("t1")), { method: "POST", url: "/api/app/admin/workspaces/t1/restore", body: {} });
    assert.deepEqual(await sent((a) => a.admin.workspaces(), { json: { workspaces: [] } }), { method: "GET", url: "/api/app/admin/workspaces", body: undefined });
    assert.deepEqual(await sent((a) => a.admin.workspace("t1"), { json: { workspace: {} } }), { method: "GET", url: "/api/app/admin/workspaces/t1", body: undefined });
    assert.deepEqual(await sent((a) => a.teams.create({ name: "Rocket" }), { status: 201, json: { team: {} } }), { method: "POST", url: "/api/app/teams", body: { name: "Rocket" } });
    assert.deepEqual(await sent((a) => a.teams.removeSession("WH", "s/1")), { method: "DELETE", url: "/api/app/teams/WH/sessions/s%2F1", body: undefined });
    assert.deepEqual(await sent((a) => a.dashboard.widget("activity-split"), { json: [] }), { method: "GET", url: "/api/app/dashboard/activity-split", body: undefined });
  });
});

describe("the board endpoints (WH-96)", () => {
  const sent = async (run: (api: ReturnType<typeof createApiClient>) => Promise<unknown>, reply: { status?: number; json?: unknown } = { json: { ok: true } }) => {
    const s = script([{ json: me("tok") }, reply]);
    const api = createApiClient({ fetch: s.f });
    await api.me();
    await run(api);
    const { method, url, body } = s.calls[1];
    return { method, url, body };
  };

  test("the board and the queue are reads, with the team key escaped; the queue comes out of its envelope", async () => {
    assert.deepEqual(await sent((a) => a.teams.board("W H"), { json: {} }), { method: "GET", url: "/api/app/teams/W%20H/board", body: undefined });
    const s = script([{ json: { bots: [{ id: "k1" }] } }]);
    assert.deepEqual(await createApiClient({ fetch: s.f }).teams.queue("WH"), [{ id: "k1" }]);
    assert.equal(s.calls[0].url, "/api/app/teams/WH/queue");
  });

  test("issues: create, read, edit, move, delete, comment, link and unlink, each at its address with the ref escaped", async () => {
    const t = { issue: { ref: "WH-1" } };
    assert.deepEqual(await sent((a) => a.issues.create("WH", { title: "x", status: "review" }), { status: 201, json: t }), { method: "POST", url: "/api/app/teams/WH/issues", body: { title: "x", status: "review" } });
    assert.deepEqual(await sent((a) => a.issues.get("WH-1"), { json: {} }), { method: "GET", url: "/api/app/issues/WH-1", body: undefined });
    assert.deepEqual(await sent((a) => a.issues.update("WH-1", { title: "y", version: 3 }), { json: t }), { method: "PATCH", url: "/api/app/issues/WH-1", body: { title: "y", version: 3 } });
    assert.deepEqual(await sent((a) => a.issues.move("WH-1", { status: "Done", index: 0 }), { json: t }), { method: "POST", url: "/api/app/issues/WH-1/move", body: { status: "Done", index: 0 } });
    assert.deepEqual(await sent((a) => a.issues.remove("WH-1")), { method: "DELETE", url: "/api/app/issues/WH-1", body: undefined });
    assert.deepEqual(await sent((a) => a.issues.comment("WH-1", "hi"), { status: 201, json: { comment: {} } }), { method: "POST", url: "/api/app/issues/WH-1/comments", body: { body: "hi" } });
    assert.deepEqual(await sent((a) => a.issues.link("WH-1", "n/1")), { method: "PUT", url: "/api/app/issues/WH-1/nodes/n%2F1", body: {} });
    assert.deepEqual(await sent((a) => a.issues.unlink("WH-1", "n1")), { method: "DELETE", url: "/api/app/issues/WH-1/nodes/n1", body: undefined });
  });

  test("a stale edit rejects with the issue as it is now in `current`, and says it is a conflict", async () => {
    const s = script([{ json: me("tok") }, { status: 409, json: { error: { code: "conflict", message: "WH-1 was changed (version 2, you had 1).", details: { current: { ref: "WH-1", version: 2 } } } } }]);
    const api = createApiClient({ fetch: s.f });
    await api.me();
    const e = await failure(api.issues.update("WH-1", { body: "mine", version: 1 }));
    assert.equal(e.isConflict, true);
    assert.deepEqual(e.current, { ref: "WH-1", version: 2 });
    assert.equal(e.status, 409);
  });
});

describe("the map endpoints (WH-97)", () => {
  const sent = async (run: (api: ReturnType<typeof createApiClient>) => Promise<unknown>, reply: { status?: number; json?: unknown } = { json: { ok: true } }) => {
    const s = script([{ json: me("tok") }, reply]);
    const api = createApiClient({ fetch: s.f });
    await api.me();
    await run(api);
    const { method, url, body } = s.calls[1];
    return { method, url, body };
  };

  test("the graph is a read; nodes, layout and edges go to their addresses with ids escaped, and the node comes out of its envelope", async () => {
    assert.deepEqual(await sent((a) => a.map.graph("W H"), { json: {} }), { method: "GET", url: "/api/app/teams/W%20H/graph", body: undefined });
    assert.deepEqual(await sent((a) => a.map.upsertNode("WH", { id: "n1", summary: "s", version: 3 }), { json: { node: {} } }), { method: "PUT", url: "/api/app/teams/WH/nodes", body: { id: "n1", summary: "s", version: 3 } });
    assert.deepEqual(await sent((a) => a.map.deleteNode("WH", "n/1")), { method: "DELETE", url: "/api/app/teams/WH/nodes/n%2F1", body: undefined });
    assert.deepEqual(await sent((a) => a.map.markFresh("WH", "n1"), { json: { node: {} } }), { method: "POST", url: "/api/app/teams/WH/nodes/n1/fresh", body: {} });
    assert.deepEqual(await sent((a) => a.map.saveLayout("WH", [{ id: "n1", x: 1, y: 2 }], { placed: false })), { method: "PUT", url: "/api/app/teams/WH/layout", body: { positions: [{ id: "n1", x: 1, y: 2 }], placed: false } });
    assert.deepEqual(await sent((a) => a.map.connect("WH", { from: "a", to: "b", kind: "implements" }), { json: { edge: {} } }), { method: "POST", url: "/api/app/teams/WH/edges", body: { from: "a", to: "b", kind: "implements" } });
    assert.deepEqual(await sent((a) => a.map.deleteEdge("WH", "e1")), { method: "DELETE", url: "/api/app/teams/WH/edges/e1", body: undefined });
    const s = script([{ json: { node: { id: "n1", version: 2 } } }]);
    assert.deepEqual(await createApiClient({ fetch: s.f }).map.upsertNode("WH", { name: "x" }), { id: "n1", version: 2 });
  });

  test("flows, decisions and terms: the term is in the path (escaped), the rest in the body", async () => {
    assert.deepEqual(await sent((a) => a.map.upsertFlow("WH", { name: "F", steps: [{ node: "n1", title: "t" }], version: 1 }), { json: { flow: {} } }), { method: "PUT", url: "/api/app/teams/WH/flows", body: { name: "F", steps: [{ node: "n1", title: "t" }], version: 1 } });
    assert.deepEqual(await sent((a) => a.map.deleteFlow("WH", "f1")), { method: "DELETE", url: "/api/app/teams/WH/flows/f1", body: undefined });
    assert.deepEqual(await sent((a) => a.map.upsertDecision("WH", { number: 2, status: "accepted", version: 4 }), { json: { decision: {} } }), { method: "PUT", url: "/api/app/teams/WH/decisions", body: { number: 2, status: "accepted", version: 4 } });
    assert.deepEqual(await sent((a) => a.map.upsertTerm("WH", "CI/CD pipeline", { definition: "d", node: null }), { json: { term: {} } }), { method: "PUT", url: "/api/app/teams/WH/terms/CI%2FCD%20pipeline", body: { definition: "d", node: null } });
    assert.deepEqual(await sent((a) => a.map.deleteTerm("WH", "Work item")), { method: "DELETE", url: "/api/app/teams/WH/terms/Work%20item", body: undefined });
  });

  test("drafts, ask and activity", async () => {
    assert.deepEqual(await sent((a) => a.map.resolveDraft("WH", "d1", "publish")), { method: "POST", url: "/api/app/teams/WH/drafts/d1/resolve", body: { action: "publish" } });
    assert.deepEqual(await sent((a) => a.map.ask("WH", "Why?", "n1"), { json: { answer: "a", truncated: false } }), { method: "POST", url: "/api/app/teams/WH/ask", body: { question: "Why?", focus: "n1" } });
    assert.deepEqual((await sent((a) => a.map.ask("WH", "Why?"), { json: { answer: "a", truncated: false } })).body, { question: "Why?" }, "no focus, no focus field");
    assert.deepEqual(await sent((a) => a.map.activity("WH", "agent"), { json: { events: [] } }), { method: "GET", url: "/api/app/teams/WH/activity?who=agent", body: undefined });
    assert.equal((await sent((a) => a.map.activity("WH"), { json: { events: [] } })).url, "/api/app/teams/WH/activity");
    const s = script([{ json: { events: [{ seq: 1 }] } }]);
    assert.deepEqual(await createApiClient({ fetch: s.f }).map.activity("WH"), [{ seq: 1 }]);
  });

  test("a stale edit of a node rejects with the node as it is now", async () => {
    const s = script([{ json: me("tok") }, { status: 409, json: { error: { code: "conflict", message: '"Svc" was changed (version 2, you had 1).', details: { current: { id: "n1", version: 2 } } } } }]);
    const api = createApiClient({ fetch: s.f });
    await api.me();
    const e = await failure(api.map.upsertNode("WH", { id: "n1", summary: "mine", version: 1 }));
    assert.deepEqual([e.isConflict, e.current], [true, { id: "n1", version: 2 }]);
  });
});

describe("the docs, repositories and onboarding endpoints (WH-98)", () => {
  const sent = async (run: (api: ReturnType<typeof createApiClient>) => Promise<unknown>, reply: { status?: number; json?: unknown } = { json: { ok: true } }) => {
    const s = script([{ json: me("tok") }, reply]);
    const api = createApiClient({ fetch: s.f });
    await api.me();
    await run(api);
    const { method, url, body } = s.calls[1];
    return { method, url, body };
  };

  test("docs: each call goes to its address with the ref escaped, and the doc comes out of its envelope", async () => {
    assert.deepEqual(await sent((a) => a.docs.index("WH"), { json: { docs: [] } }), { method: "GET", url: "/api/app/teams/WH/docs", body: undefined });
    assert.deepEqual(await sent((a) => a.docs.get("WH", "a b"), { json: { doc: {}, nodes: [] } }), { method: "GET", url: "/api/app/teams/WH/docs/a%20b", body: undefined });
    assert.deepEqual(await sent((a) => a.docs.create("WH", { title: "T", template: "spec", parent: null }), { json: { doc: {} } }), { method: "POST", url: "/api/app/teams/WH/docs", body: { title: "T", template: "spec", parent: null } });
    assert.deepEqual(await sent((a) => a.docs.update("WH", "d1", { body: "x", version: 3 }), { json: { doc: {} } }), { method: "PATCH", url: "/api/app/teams/WH/docs/d1", body: { body: "x", version: 3 } });
    assert.deepEqual(await sent((a) => a.docs.markFresh("WH", "d1"), { json: { doc: {} } }), { method: "POST", url: "/api/app/teams/WH/docs/d1/fresh", body: {} });
    assert.deepEqual(await sent((a) => a.docs.move("WH", "d1", { parent: null, version: 2 }), { json: { doc: {} } }), { method: "POST", url: "/api/app/teams/WH/docs/d1/move", body: { parent: null, version: 2 } });
    assert.deepEqual(await sent((a) => a.docs.delete("WH", "d1")), { method: "DELETE", url: "/api/app/teams/WH/docs/d1", body: undefined });
    assert.deepEqual(await sent((a) => a.docs.linkNode("WH", "d1", "n/1")), { method: "PUT", url: "/api/app/teams/WH/docs/d1/nodes/n%2F1", body: {} });
    assert.deepEqual(await sent((a) => a.docs.unlinkNode("WH", "d1", "n1")), { method: "DELETE", url: "/api/app/teams/WH/docs/d1/nodes/n1", body: undefined });
    const s = script([{ json: { anchors: ["src/a.ts"] } }]);
    assert.deepEqual(await createApiClient({ fetch: s.f }).docs.anchorSuggestions("WH", "d1"), ["src/a.ts"]);
  });

  test("a stale save of a doc rejects with the doc as it is now", async () => {
    const s = script([{ json: me("tok") }, { status: 409, json: { error: { code: "conflict", message: 'Doc "Plan" was changed (version 3, you had 2). Re-read and retry.', details: { current: { id: "d1", version: 3 } } } } }]);
    const api = createApiClient({ fetch: s.f });
    await api.me();
    const e = await failure(api.docs.update("WH", "d1", { body: "mine", version: 2 }));
    assert.deepEqual([e.isConflict, e.current], [true, { id: "d1", version: 3 }]);
  });

  test("projects: reads unwrap; changes go to the project's id, its teams and its milestones", async () => {
    const s = script([{ json: { projects: [{ id: "p1" }] } }]);
    assert.deepEqual(await createApiClient({ fetch: s.f }).projects.list(), [{ id: "p1" }]);
    assert.deepEqual(await sent((a) => a.projects.get("p1"), { json: { project: { id: "p1" } } }), { method: "GET", url: "/api/app/projects/p1", body: undefined });
    assert.deepEqual(await sent((a) => a.projects.create({ name: "Launch", leadTeam: "WH", teams: ["AT"] }), { json: { project: {} } }), { method: "POST", url: "/api/app/projects", body: { name: "Launch", leadTeam: "WH", teams: ["AT"] } });
    assert.deepEqual(await sent((a) => a.projects.update("p1", { healthOverride: null, version: 2 }), { json: { project: {} } }), { method: "PATCH", url: "/api/app/projects/p1", body: { healthOverride: null, version: 2 } });
    assert.deepEqual(await sent((a) => a.projects.delete("p1"), { json: { ok: true, released: 0 } }), { method: "DELETE", url: "/api/app/projects/p1", body: undefined });
    assert.deepEqual(await sent((a) => a.projects.addTeam("p1", "AT"), { json: { project: {} } }), { method: "POST", url: "/api/app/projects/p1/teams", body: { team: "AT" } });
    assert.deepEqual(await sent((a) => a.projects.removeTeam("p1", "AT"), { json: { ok: true } }), { method: "DELETE", url: "/api/app/projects/p1/teams/AT", body: undefined });
    assert.deepEqual(await sent((a) => a.projects.removeTeam("p1", "AT", { releaseIssues: true }), { json: { ok: true } }), { method: "DELETE", url: "/api/app/projects/p1/teams/AT?releaseIssues=1", body: undefined });
    assert.deepEqual(await sent((a) => a.projects.addMilestone("p1", { name: "Beta" }), { json: { project: {} } }), { method: "POST", url: "/api/app/projects/p1/milestones", body: { name: "Beta" } });
    assert.deepEqual(await sent((a) => a.projects.updateMilestone("p1", "m1", { index: 0 }), { json: { project: {} } }), { method: "PATCH", url: "/api/app/projects/p1/milestones/m1", body: { index: 0 } });
    assert.deepEqual(await sent((a) => a.projects.deleteMilestone("p1", "m1"), { json: { project: {} } }), { method: "DELETE", url: "/api/app/projects/p1/milestones/m1", body: undefined });
  });

  test("cycles: list and get unwrap; create, update and delete go to the team's cycles by number", async () => {
    const s = script([{ json: { current: null, upcoming: [], past: [] } }]);
    assert.deepEqual(await createApiClient({ fetch: s.f }).cycles.list("WH"), { current: null, upcoming: [], past: [] });
    assert.deepEqual(await sent((a) => a.cycles.get("WH", 3), { json: { cycle: { number: 3 } } }), { method: "GET", url: "/api/app/teams/WH/cycles/3", body: undefined });
    assert.deepEqual(await sent((a) => a.cycles.create("WH", { name: "Spring", startsAt: "2026-10-20T00:00:00.000Z" }), { json: { cycle: {} } }), { method: "POST", url: "/api/app/teams/WH/cycles", body: { name: "Spring", startsAt: "2026-10-20T00:00:00.000Z" } });
    assert.deepEqual(await sent((a) => a.cycles.update("WH", 3, { goal: "x" }), { json: { cycle: {} } }), { method: "PATCH", url: "/api/app/teams/WH/cycles/3", body: { goal: "x" } });
    assert.deepEqual(await sent((a) => a.cycles.delete("WH", 3), { json: { ok: true } }), { method: "DELETE", url: "/api/app/teams/WH/cycles/3", body: undefined });
  });

  test("repositories: list and retire unwrap; GitHub connect sends the repository's GitHub id as repoId", async () => {
    const s = script([{ json: { repositories: [{ id: "r1" }] } }]);
    assert.deepEqual(await createApiClient({ fetch: s.f }).repos.list("WH"), [{ id: "r1" }]);
    assert.deepEqual(await sent((a) => a.repos.create("WH", { displayName: "API", role: "backend" }), { json: { repository: {} } }), { method: "POST", url: "/api/app/teams/WH/repositories", body: { displayName: "API", role: "backend" } });
    assert.deepEqual(await sent((a) => a.repos.update("WH", "r1", { pathLimit: null }), { json: { repository: {} } }), { method: "PATCH", url: "/api/app/teams/WH/repositories/r1", body: { pathLimit: null } });
    assert.deepEqual(await sent((a) => a.repos.retire("WH", "r1"), { json: { repository: {} } }), { method: "POST", url: "/api/app/teams/WH/repositories/r1/retire", body: {} });
    assert.deepEqual(await sent((a) => a.repos.tree("WH", "r1"), { json: { files: [], truncated: false } }), { method: "GET", url: "/api/app/teams/WH/repositories/r1/tree", body: undefined });
    assert.deepEqual(await sent((a) => a.repos.github("WH"), { json: { configured: false } }), { method: "GET", url: "/api/app/teams/WH/repositories/github", body: undefined });
    assert.deepEqual(await sent((a) => a.repos.connectGithub("WH", { installationId: "1", repoId: "5", role: "backend" }), { json: { repository: {} } }), { method: "POST", url: "/api/app/teams/WH/repositories/github", body: { installationId: "1", repoId: "5", role: "backend" } });
  });

  test("onboarding: the page is a read, and the description goes in the body", async () => {
    assert.deepEqual(await sent((a) => a.onboarding.page("WH"), { json: {} }), { method: "GET", url: "/api/app/teams/WH/onboarding", body: undefined });
    assert.deepEqual(await sent((a) => a.onboarding.startMap("WH", "A tool")), { method: "POST", url: "/api/app/teams/WH/onboarding/concept", body: { description: "A tool" } });
  });
});
