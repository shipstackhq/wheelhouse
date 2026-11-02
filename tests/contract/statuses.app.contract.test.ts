import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { anon, app, newEmail, sessionFrom, type Sess } from "./lib/app";

/**
 * A team's statuses over real HTTP: read by anyone on the team, changed only by its admins, kept inside the team, and the rules that
 * keep a board usable (a role never changes, a team keeps one status in each required role, a status with issues says where they go).
 * Everything runs in accounts made for the test.
 */
const PW = "a-long-enough-password";
type Person = { sess: Sess; id: string };

async function signUp(name: string): Promise<Person> {
  const r = await app("POST", "/api/app/auth/signup", anon(), { body: { name, email: newEmail(), password: PW, workspace: `${name} workspace` } });
  assert.equal(r.status, 201, r.text);
  return { sess: sessionFrom(r), id: r.json.user.id };
}
async function join(owner: Person, name: string): Promise<Person> {
  const email = newEmail();
  const inv = await app("POST", "/api/app/invites", owner.sess, { body: { kind: "join_workspace", email, role: "member" } });
  assert.equal(inv.status, 201, inv.text);
  const r = await app("POST", "/api/app/invites/accept", anon(), { body: { token: inv.json.link.split("#")[1], name, password: PW, confirm: PW } });
  assert.equal(r.status, 201, r.text);
  return { sess: sessionFrom(r), id: r.json.user.id };
}

/** An owner (admin of the team ST), an editor and a viewer of it, and a stranger with a workspace of their own. */
async function setup() {
  const owner = await signUp("Owner");
  const editor = await join(owner, "Eddie");
  const viewer = await join(owner, "Vic");
  const stranger = await signUp("Stranger");
  assert.equal((await app("POST", "/api/app/teams", owner.sess, { body: { name: "Status team", key: "STT" } })).status, 201);
  for (const [p, role] of [[editor, "editor"], [viewer, "viewer"]] as const) {
    assert.equal((await app("POST", "/api/app/teams/STT/members", owner.sess, { body: { userId: p.id, role } })).status, 201);
  }
  return { owner, editor, viewer, stranger };
}
const list = async (s: Sess) => (await app("GET", "/api/app/teams/STT/statuses", s)).json.statuses as { id: string; name: string; role: string; isDefault: boolean; color: string | null; position: number; issueCount: number }[];
const named = async (s: Sess, name: string) => (await list(s)).find((x) => x.name === name)!;

describe("every endpoint needs a signed-in person, and refuses a forged request", () => {
  const table: [string, string, unknown?][] = [
    ["GET", "/api/app/teams/STT/statuses"],
    ["POST", "/api/app/teams/STT/statuses", { name: "x", role: "todo" }],
    ["PUT", "/api/app/teams/STT/statuses/order", { ids: [] }],
    ["PATCH", "/api/app/teams/STT/statuses/Todo", { name: "x" }],
    ["DELETE", "/api/app/teams/STT/statuses/Todo"],
  ];
  for (const [method, path, body] of table) {
    test(`${method} ${path}: 401 as JSON when signed out`, async () => {
      const r = await app(method, path, anon(), { body });
      assert.equal(r.status, 401);
      assert.equal(r.json.error.code, "unauthorized");
    });
  }

  test("a forged request (another site, no token, a wrong token) changes nothing", async () => {
    const t = await setup();
    const before = await list(t.owner.sess);
    for (const f of [{ origin: "https://evil.example" }, { csrf: null }, { csrf: "wrong" }]) {
      for (const [method, path, body] of [
        ["POST", "/api/app/teams/STT/statuses", { name: "Forged", role: "todo" }],
        ["PATCH", "/api/app/teams/STT/statuses/Todo", { name: "Forged" }],
        ["PUT", "/api/app/teams/STT/statuses/order", { ids: before.map((s) => s.id).reverse() }],
        ["DELETE", "/api/app/teams/STT/statuses/Review", undefined],
      ] as const) {
        const r = await app(method, path, t.owner.sess, { ...f, body });
        assert.equal(r.status, 403, `${method} ${path} ${JSON.stringify(f)}`);
        assert.equal(r.json.error.code, "csrf_failed");
      }
    }
    assert.deepEqual(await list(t.owner.sess), before);
  });
});

describe("reading", () => {
  test("a team's statuses in board order, with role, default, colour and issue counts; any member can read", async () => {
    const t = await setup();
    const r = await app("GET", "/api/app/teams/STT/statuses", t.viewer.sess);
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json), ["statuses"]);
    assert.deepEqual(r.json.statuses.map((s: { name: string; role: string; isDefault: boolean; color: null; issueCount: number }) => [s.name, s.role, s.isDefault, s.color, s.issueCount]), [
      ["Backlog", "backlog", true, null, 0], ["Todo", "todo", true, null, 0], ["In Progress", "in_progress", true, null, 0],
      ["Review", "review", true, null, 0], ["Done", "done", true, null, 0], ["Canceled", "canceled", true, null, 0],
    ]);
    assert.deepEqual(Object.keys(r.json.statuses[0]).sort(), ["color", "id", "isDefault", "issueCount", "name", "position", "role"]);
    assert.deepEqual((await app("GET", "/api/app/teams/STT/board", t.viewer.sess)).json.statuses.map((s: { name: string }) => s.name), r.json.statuses.map((s: { name: string }) => s.name), "the board reads the same list");
  });
});

describe("who can change them", () => {
  test("an admin can; an editor and a viewer get a 403 and nothing changes; a stranger's workspace gets a 404 on every route", async () => {
    const t = await setup();
    const before = await list(t.owner.sess);
    const todo = before.find((s) => s.name === "Todo")!;
    const writes = [
      ["POST", "/api/app/teams/STT/statuses", { name: "Nope", role: "todo" }],
      ["PATCH", `/api/app/teams/STT/statuses/${todo.id}`, { name: "Nope" }],
      ["PUT", "/api/app/teams/STT/statuses/order", { ids: before.map((s) => s.id) }],
      ["DELETE", `/api/app/teams/STT/statuses/${todo.id}`, undefined],
    ] as const;
    for (const who of [t.editor, t.viewer]) {
      for (const [method, path, body] of writes) {
        const r = await app(method, path, who.sess, { body });
        assert.equal(r.status, 403, `${method} ${path}`);
        assert.equal(r.json.error.code, "forbidden");
      }
    }
    for (const [method, path, body] of [["GET", "/api/app/teams/STT/statuses", undefined], ...writes] as const) {
      const r = await app(method, path, t.stranger.sess, { body });
      assert.equal(r.status, 404, `${method} ${path}`);
      assert.equal(r.json.error.code, "not_found");
    }
    assert.deepEqual(await list(t.owner.sess), before);
  });
});

describe("POST /api/app/teams/:key/statuses", () => {
  test("201 with the new status at the end of its role's group; a name and role are needed, a name is taken once", async () => {
    const t = await setup();
    const r = await app("POST", "/api/app/teams/STT/statuses", t.owner.sess, { body: { name: " In Review ", role: "in_progress", color: "violet" } });
    assert.equal(r.status, 201, r.text);
    assert.deepEqual({ ...r.json.status, id: "-", position: 0 }, { id: "-", name: "In Review", role: "in_progress", isDefault: false, color: "violet", position: 0, issueCount: 0 });
    assert.deepEqual((await list(t.owner.sess)).map((s) => s.name), ["Backlog", "Todo", "In Progress", "In Review", "Review", "Done", "Canceled"]);
    for (const [body, field] of [[{ role: "todo" }, "name"], [{ name: "", role: "todo" }, "name"], [{ name: 3, role: "todo" }, "name"], [{ name: "x".repeat(41), role: "todo" }, "name"], [{ name: "Fine" }, "role"], [{ name: "Fine", role: "blocked" }, "role"], [{ name: "Fine", role: "todo", color: "chartreuse" }, "color"]] as const) {
      const bad = await app("POST", "/api/app/teams/STT/statuses", t.owner.sess, { body });
      assert.equal(bad.status, 400, JSON.stringify(body));
      assert.deepEqual(Object.keys(bad.json.error.details.fields), [field], JSON.stringify(body));
    }
    const dup = await app("POST", "/api/app/teams/STT/statuses", t.owner.sess, { body: { name: "in review", role: "todo" } });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.error.code, "conflict");
  });
});

describe("PATCH /api/app/teams/:key/statuses/:id", () => {
  test("rename, recolour and make default, by id or by name; a role cannot change", async () => {
    const t = await setup();
    await app("POST", "/api/app/teams/STT/statuses", t.owner.sess, { body: { name: "Doing more", role: "in_progress" } });
    const more = await named(t.owner.sess, "Doing more");
    const r = await app("PATCH", `/api/app/teams/STT/statuses/${more.id}`, t.owner.sess, { body: { name: "Deep work", color: "teal", isDefault: true } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.json.status.name, r.json.status.color, r.json.status.isDefault], ["Deep work", "teal", true]);
    assert.equal((await named(t.owner.sess, "In Progress")).isDefault, false, "the old default let go");
    assert.equal((await app("PATCH", "/api/app/teams/STT/statuses/todo", t.owner.sess, { body: { name: "Up next" } })).json.status.name, "Up next", "by name, any case");
    const role = await app("PATCH", `/api/app/teams/STT/statuses/${more.id}`, t.owner.sess, { body: { role: "done" } });
    assert.equal(role.status, 400);
    assert.deepEqual(Object.keys(role.json.error.details.fields), ["role"]);
    for (const body of [{ isDefault: false }, { name: "Done" }, { color: "chartreuse" }, { name: 4 }]) {
      assert.ok([400, 409].includes((await app("PATCH", `/api/app/teams/STT/statuses/${more.id}`, t.owner.sess, { body })).status), JSON.stringify(body));
    }
    assert.equal((await app("PATCH", "/api/app/teams/STT/statuses/00000000-0000-4000-8000-000000000000", t.owner.sess, { body: { name: "x" } })).status, 404);
  });
});

describe("PUT /api/app/teams/:key/statuses/order", () => {
  test("every status in the order wanted; the board follows; a list that is not the team's, or breaks the roles, is a 400", async () => {
    const t = await setup();
    await app("POST", "/api/app/teams/STT/statuses", t.owner.sess, { body: { name: "Triage", role: "backlog" } });
    const ids = (await list(t.owner.sess)).map((s) => s.id);
    const swapped = [ids[1], ids[0], ...ids.slice(2)]; // Triage ahead of Backlog: both backlog
    const ok = await app("PUT", "/api/app/teams/STT/statuses/order", t.owner.sess, { body: { ids: swapped } });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(ok.json.statuses.map((s: { id: string }) => s.id), swapped);
    assert.deepEqual((await app("GET", "/api/app/teams/STT/board", t.owner.sess)).json.statuses.map((s: { id: string }) => s.id), swapped);
    for (const bad of [{}, { ids: "x" }, { ids: swapped.slice(1) }, { ids: [...swapped, swapped[0]] }, { ids: [...swapped].reverse() }]) {
      const r = await app("PUT", "/api/app/teams/STT/statuses/order", t.owner.sess, { body: bad });
      assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 50));
      assert.deepEqual(Object.keys(r.json.error.details.fields), ["ids"]);
    }
    assert.deepEqual((await list(t.owner.sess)).map((s) => s.id), swapped, "the refusals changed nothing");
  });
});

describe("DELETE /api/app/teams/:key/statuses/:id", () => {
  test("an empty one goes; one with issues needs ?moveTo=, which keeps their order; the last of a required role stays", async () => {
    const t = await setup();
    await app("POST", "/api/app/teams/STT/statuses", t.owner.sess, { body: { name: "Blocked", role: "todo" } });
    const make = async (title: string, status: string) => (await app("POST", "/api/app/teams/STT/issues", t.owner.sess, { body: { title, status } })).json.issue;
    const a = await make("a", "Blocked");
    await make("b", "Blocked");
    await make("c", "Todo");
    const refused = await app("DELETE", "/api/app/teams/STT/statuses/Blocked", t.owner.sess);
    assert.equal(refused.status, 409);
    assert.equal(refused.json.error.details.issues, 2);
    assert.equal((await named(t.owner.sess, "Blocked")).issueCount, 2, "still there, still full");
    const moved = await app("DELETE", "/api/app/teams/STT/statuses/Blocked?moveTo=Todo", t.owner.sess);
    assert.equal(moved.status, 200, moved.text);
    assert.deepEqual(moved.json, { ok: true, deleted: "Blocked", moved: 2 });
    const board = (await app("GET", "/api/app/teams/STT/board", t.owner.sess)).json;
    const todoId = board.statuses.find((s: { name: string }) => s.name === "Todo").id;
    assert.deepEqual(board.issues.filter((i: { statusId: string }) => i.statusId === todoId).sort((x: { position: number }, y: { position: number }) => x.position - y.position).map((i: { title: string }) => i.title), ["c", "a", "b"]);
    assert.equal(board.issues.find((i: { ref: string }) => i.ref === a.ref).version, a.version + 1);
    const empty = await app("DELETE", "/api/app/teams/STT/statuses/Review", t.owner.sess);
    assert.deepEqual(empty.json, { ok: true, deleted: "Review", moved: 0 });
    const last = await app("DELETE", "/api/app/teams/STT/statuses/Canceled", t.owner.sess);
    assert.equal(last.status, 409);
    assert.match(last.json.error.message, /last canceled status/);
    await app("POST", "/api/app/teams/STT/statuses", t.owner.sess, { body: { name: "Spare", role: "todo" } });
    await make("d", "Spare");
    assert.equal((await app("DELETE", "/api/app/teams/STT/statuses/Spare?moveTo=Nowhere", t.owner.sess)).status, 404);
    assert.equal((await app("DELETE", "/api/app/teams/STT/statuses/Spare?moveTo=Spare", t.owner.sess)).status, 400);
    assert.equal((await named(t.owner.sess, "Spare")).issueCount, 1, "the refusals moved nothing");
  });
});
