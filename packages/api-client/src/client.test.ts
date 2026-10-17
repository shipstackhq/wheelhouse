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

  test("team: overview is a read; a member change is a PATCH with the id escaped; removal is a DELETE; the member comes out of the envelope", async () => {
    assert.deepEqual(await sent((a) => a.team.overview(), { json: { team: {} } }), { method: "GET", url: "/api/app/team", body: undefined });
    const patch = await sent((a) => a.team.updateMember("a b/c", { role: "owner", tags: ["x"] }), { json: { member: {} } });
    assert.deepEqual(patch, { method: "PATCH", url: "/api/app/team/members/a%20b%2Fc", body: { role: "owner", tags: ["x"] } });
    assert.deepEqual(await sent((a) => a.team.removeMember("u1")), { method: "DELETE", url: "/api/app/team/members/u1", body: undefined });
    const s = script([{ json: { member: { userId: "u1", tags: ["x"] } } }]);
    assert.deepEqual(await createApiClient({ fetch: s.f }).team.updateMember("u1", { role: "member", tags: "x" }), { userId: "u1", tags: ["x"] });
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
    assert.deepEqual(await sent((a) => a.agents.page(), { json: { keys: [], setup: {} } }), { method: "GET", url: "/api/app/agents", body: undefined });
    assert.deepEqual(await sent((a) => a.agents.markAllSeen({ keyId: "k1" })), { method: "POST", url: "/api/app/agents/mark-all-seen", body: { keyId: "k1" } });
  });

  test("invites: list picks the kind and unwraps; peek is a POST so the token never sits in a URL; accept adopts the new session's token", async () => {
    const list = script([{ json: { invites: [{ id: "i1" }] } }]);
    assert.deepEqual(await createApiClient({ fetch: list.f }).invites.list("new_team"), [{ id: "i1" }]);
    assert.equal(list.calls[0].url, "/api/app/invites?kind=new_team");
    assert.deepEqual(await sent((a) => a.invites.create({ kind: "join_team", email: "x@y.z" }), { status: 201, json: {} }), { method: "POST", url: "/api/app/invites", body: { kind: "join_team", email: "x@y.z" } });
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

  test("admin, projects and dashboard", async () => {
    assert.deepEqual(await sent((a) => a.admin.suspend("t1", { confirm: "Acme", reason: "x" }), { json: { name: "Acme", sessionsEnded: 0 } }), { method: "POST", url: "/api/app/admin/teams/t1/suspend", body: { confirm: "Acme", reason: "x" } });
    assert.deepEqual(await sent((a) => a.admin.restore("t1")), { method: "POST", url: "/api/app/admin/teams/t1/restore", body: {} });
    assert.deepEqual(await sent((a) => a.admin.teams(), { json: { teams: [] } }), { method: "GET", url: "/api/app/admin/teams", body: undefined });
    assert.deepEqual(await sent((a) => a.admin.team("t1"), { json: { team: {} } }), { method: "GET", url: "/api/app/admin/teams/t1", body: undefined });
    assert.deepEqual(await sent((a) => a.projects.create({ name: "Rocket" }), { status: 201, json: { project: {} } }), { method: "POST", url: "/api/app/projects", body: { name: "Rocket" } });
    assert.deepEqual(await sent((a) => a.projects.removeSession("WH", "s/1")), { method: "DELETE", url: "/api/app/projects/WH/sessions/s%2F1", body: undefined });
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

  test("the board and the queue are reads, with the project key escaped; the queue comes out of its envelope", async () => {
    assert.deepEqual(await sent((a) => a.projects.board("W H"), { json: {} }), { method: "GET", url: "/api/app/projects/W%20H/board", body: undefined });
    const s = script([{ json: { bots: [{ id: "k1" }] } }]);
    assert.deepEqual(await createApiClient({ fetch: s.f }).projects.queue("WH"), [{ id: "k1" }]);
    assert.equal(s.calls[0].url, "/api/app/projects/WH/queue");
  });

  test("tickets: create, read, edit, move, delete, comment, link and unlink, each at its address with the ref escaped", async () => {
    const t = { ticket: { ref: "WH-1" } };
    assert.deepEqual(await sent((a) => a.tickets.create("WH", { title: "x", column: "review" }), { status: 201, json: t }), { method: "POST", url: "/api/app/projects/WH/tickets", body: { title: "x", column: "review" } });
    assert.deepEqual(await sent((a) => a.tickets.get("WH-1"), { json: {} }), { method: "GET", url: "/api/app/tickets/WH-1", body: undefined });
    assert.deepEqual(await sent((a) => a.tickets.update("WH-1", { title: "y", version: 3 }), { json: t }), { method: "PATCH", url: "/api/app/tickets/WH-1", body: { title: "y", version: 3 } });
    assert.deepEqual(await sent((a) => a.tickets.move("WH-1", { column: "Done", index: 0 }), { json: t }), { method: "POST", url: "/api/app/tickets/WH-1/move", body: { column: "Done", index: 0 } });
    assert.deepEqual(await sent((a) => a.tickets.remove("WH-1")), { method: "DELETE", url: "/api/app/tickets/WH-1", body: undefined });
    assert.deepEqual(await sent((a) => a.tickets.comment("WH-1", "hi"), { status: 201, json: { comment: {} } }), { method: "POST", url: "/api/app/tickets/WH-1/comments", body: { body: "hi" } });
    assert.deepEqual(await sent((a) => a.tickets.link("WH-1", "n/1")), { method: "PUT", url: "/api/app/tickets/WH-1/nodes/n%2F1", body: {} });
    assert.deepEqual(await sent((a) => a.tickets.unlink("WH-1", "n1")), { method: "DELETE", url: "/api/app/tickets/WH-1/nodes/n1", body: undefined });
  });

  test("a stale edit rejects with the ticket as it is now in `current`, and says it is a conflict", async () => {
    const s = script([{ json: me("tok") }, { status: 409, json: { error: { code: "conflict", message: "WH-1 was changed (version 2, you had 1).", details: { current: { ref: "WH-1", version: 2 } } } } }]);
    const api = createApiClient({ fetch: s.f });
    await api.me();
    const e = await failure(api.tickets.update("WH-1", { body: "mine", version: 1 }));
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
    assert.deepEqual(await sent((a) => a.map.graph("W H"), { json: {} }), { method: "GET", url: "/api/app/projects/W%20H/graph", body: undefined });
    assert.deepEqual(await sent((a) => a.map.upsertNode("WH", { id: "n1", summary: "s", version: 3 }), { json: { node: {} } }), { method: "PUT", url: "/api/app/projects/WH/nodes", body: { id: "n1", summary: "s", version: 3 } });
    assert.deepEqual(await sent((a) => a.map.deleteNode("WH", "n/1")), { method: "DELETE", url: "/api/app/projects/WH/nodes/n%2F1", body: undefined });
    assert.deepEqual(await sent((a) => a.map.markFresh("WH", "n1"), { json: { node: {} } }), { method: "POST", url: "/api/app/projects/WH/nodes/n1/fresh", body: {} });
    assert.deepEqual(await sent((a) => a.map.saveLayout("WH", [{ id: "n1", x: 1, y: 2 }], { placed: false })), { method: "PUT", url: "/api/app/projects/WH/layout", body: { positions: [{ id: "n1", x: 1, y: 2 }], placed: false } });
    assert.deepEqual(await sent((a) => a.map.connect("WH", { from: "a", to: "b", kind: "implements" }), { json: { edge: {} } }), { method: "POST", url: "/api/app/projects/WH/edges", body: { from: "a", to: "b", kind: "implements" } });
    assert.deepEqual(await sent((a) => a.map.deleteEdge("WH", "e1")), { method: "DELETE", url: "/api/app/projects/WH/edges/e1", body: undefined });
    const s = script([{ json: { node: { id: "n1", version: 2 } } }]);
    assert.deepEqual(await createApiClient({ fetch: s.f }).map.upsertNode("WH", { name: "x" }), { id: "n1", version: 2 });
  });

  test("flows, decisions and terms: the term is in the path (escaped), the rest in the body", async () => {
    assert.deepEqual(await sent((a) => a.map.upsertFlow("WH", { name: "F", steps: [{ node: "n1", title: "t" }], version: 1 }), { json: { flow: {} } }), { method: "PUT", url: "/api/app/projects/WH/flows", body: { name: "F", steps: [{ node: "n1", title: "t" }], version: 1 } });
    assert.deepEqual(await sent((a) => a.map.deleteFlow("WH", "f1")), { method: "DELETE", url: "/api/app/projects/WH/flows/f1", body: undefined });
    assert.deepEqual(await sent((a) => a.map.upsertDecision("WH", { number: 2, status: "accepted", version: 4 }), { json: { decision: {} } }), { method: "PUT", url: "/api/app/projects/WH/decisions", body: { number: 2, status: "accepted", version: 4 } });
    assert.deepEqual(await sent((a) => a.map.upsertTerm("WH", "CI/CD pipeline", { definition: "d", node: null }), { json: { term: {} } }), { method: "PUT", url: "/api/app/projects/WH/terms/CI%2FCD%20pipeline", body: { definition: "d", node: null } });
    assert.deepEqual(await sent((a) => a.map.deleteTerm("WH", "Work item")), { method: "DELETE", url: "/api/app/projects/WH/terms/Work%20item", body: undefined });
  });

  test("drafts, ask and activity", async () => {
    assert.deepEqual(await sent((a) => a.map.resolveDraft("WH", "d1", "publish")), { method: "POST", url: "/api/app/projects/WH/drafts/d1/resolve", body: { action: "publish" } });
    assert.deepEqual(await sent((a) => a.map.ask("WH", "Why?", "n1"), { json: { answer: "a", truncated: false } }), { method: "POST", url: "/api/app/projects/WH/ask", body: { question: "Why?", focus: "n1" } });
    assert.deepEqual((await sent((a) => a.map.ask("WH", "Why?"), { json: { answer: "a", truncated: false } })).body, { question: "Why?" }, "no focus, no focus field");
    assert.deepEqual(await sent((a) => a.map.activity("WH", "agent"), { json: { events: [] } }), { method: "GET", url: "/api/app/projects/WH/activity?who=agent", body: undefined });
    assert.equal((await sent((a) => a.map.activity("WH"), { json: { events: [] } })).url, "/api/app/projects/WH/activity");
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
