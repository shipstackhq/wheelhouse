import { describe, test, before } from "node:test";
import assert from "node:assert/strict";
import { v1ok } from "./lib/http";
import { anon, app, newEmail, newAccount, sessionFrom, type Sess } from "./lib/app";

/**
 * Initiatives (WH-119): the endpoints, nesting over HTTP, and who sees what (a member of one team sees another team's project only
 * as totals, a guest sees nothing). Runs in a workspace made for the test; /api/v1 must not grow initiatives.
 */

type Initiative = {
  id: string; parentId: string | null; name: string; status: string; version: number; total: number; done: number; depth: number; canEdit: boolean;
  projectCount: number; childCount: number; health: { value: string | null };
  path: { id: string }[]; children: { id: string }[];
  projects: { id: string; name: string; direct: boolean }[]; hidden: { count: number; total: number; done: number }; linkable: { id: string }[];
};

const PW = "a-long-enough-password";
let owner: Sess;
let member: Sess;
let guest: Sess;
let teamA: string; // owner and member
let teamB: string; // owner only
let apiKey: string;
let n = 0;
let k = 0;
const newKey = () => `I${Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 3).toUpperCase()}${String.fromCharCode(65 + (k++ % 26))}`;

async function join(role: string, name: string) {
  const inv = await app("POST", "/api/app/invites", owner, { body: { kind: "join_workspace", email: newEmail(), role } });
  assert.equal(inv.status, 201, inv.text);
  const r = await app("POST", "/api/app/invites/accept", anon(), { body: { token: inv.json.link.split("#")[1], name, password: PW, confirm: PW } });
  assert.equal(r.status, 201, r.text);
  return { sess: sessionFrom(r), id: r.json.user.id as string };
}

before(async () => {
  owner = (await newAccount("Owner")).sess;
  const m = await join("member", "Member");
  member = m.sess;
  guest = (await join("guest", "Gus")).sess;
  teamA = newKey();
  teamB = newKey();
  for (const key of [teamA, teamB]) assert.equal((await app("POST", "/api/app/teams", owner, { body: { name: `Team ${key}`, key } })).status, 201);
  assert.equal((await app("POST", `/api/app/teams/${teamA}/members`, owner, { body: { userId: m.id, role: "editor" } })).status, 201);
  apiKey = (await app("POST", "/api/app/keys", owner, { body: { name: "agent" } })).json.secret as string;
});

const make = async (body: Record<string, unknown> = {}, s: Sess = owner) => {
  const r = await app("POST", "/api/app/initiatives", s, { body: { name: `Initiative ${++n}`, ...body } });
  assert.equal(r.status, 201, r.text);
  return r.json.initiative as Initiative;
};
const project = async (leadTeam: string, name: string) => {
  const r = await app("POST", "/api/app/projects", owner, { body: { name, leadTeam } });
  assert.equal(r.status, 201, r.text);
  return r.json.project as { id: string };
};
const issue = async (team: string, body: Record<string, unknown>) => {
  const r = await app("POST", `/api/app/teams/${team}/issues`, owner, { body: { title: `t ${++n}`, ...body } });
  assert.equal(r.status, 201, r.text);
};

describe("the initiatives endpoints", () => {
  test("signed out is a 401, and a forged request is refused", async () => {
    assert.equal((await app("GET", "/api/app/initiatives", anon())).status, 401);
    assert.equal((await app("POST", "/api/app/initiatives", owner, { body: {}, origin: "https://evil.example" })).status, 403);
    assert.equal((await app("POST", "/api/app/initiatives", owner, { body: {}, csrf: null })).status, 403);
  });

  test("make, read, change and delete one; the answer is the whole initiative", async () => {
    const i = await make({ description: "Words", status: "active", targetDate: "2026-12-31" });
    assert.deepEqual([i.status, i.version, i.depth, i.canEdit, i.parentId], ["active", 1, 1, true, null]);
    const list = (await app("GET", "/api/app/initiatives", owner)).json.initiatives as Initiative[];
    assert.ok(list.some((x) => x.id === i.id));
    const patched = await app("PATCH", `/api/app/initiatives/${i.id}`, owner, { body: { name: "Renamed", version: 1 } });
    assert.equal(patched.status, 200, patched.text);
    assert.equal(patched.json.initiative.name, "Renamed");
    assert.equal((await app("PATCH", `/api/app/initiatives/${i.id}`, owner, { body: { name: "Stale", version: 1 } })).status, 409);
    const del = await app("DELETE", `/api/app/initiatives/${i.id}`, owner);
    assert.equal(del.status, 200, del.text);
    assert.equal((await app("GET", `/api/app/initiatives/${i.id}`, owner)).status, 404);
  });

  test("a bad request is a 400 naming the field; an unknown or malformed id is a 404", async () => {
    for (const [body, field] of [[{ name: "" }, "name"], [{ status: "completed" }, "status"], [{ targetDate: "soon" }, "targetDate"], [{ parentId: "nope" }, "parentId"]] as const) {
      const r = await app("POST", "/api/app/initiatives", owner, { body: Object.assign({ name: "x" }, body) });
      assert.equal(r.status, 400, r.text);
      assert.ok(r.json.error.details?.fields?.[field], `names ${field}: ${r.text}`);
    }
    assert.equal((await app("GET", "/api/app/initiatives/not-an-id", owner)).status, 404);
    assert.equal((await app("GET", "/api/app/initiatives/00000000-0000-4000-8000-000000000000", owner)).status, 404);
  });

  test("nesting stops at three levels and a cycle is refused", async () => {
    const a = await make();
    const b = await make({ parentId: a.id });
    const c = await make({ parentId: b.id });
    assert.equal(c.depth, 3);
    assert.deepEqual(c.path.map((p) => p.id), [a.id, b.id]);
    const four = await app("POST", "/api/app/initiatives", owner, { body: { name: "four", parentId: c.id } });
    assert.equal(four.status, 400, four.text);
    const cycle = await app("PATCH", `/api/app/initiatives/${a.id}`, owner, { body: { parentId: c.id } });
    assert.equal(cycle.status, 400, cycle.text);
  });

  test("a project is linked once, counts once however it is reached, and unlinking leaves it alone", async () => {
    const top = await make({ status: "active" });
    const sub = await make({ parentId: top.id });
    const p = await project(teamA, `Linked ${n}`);
    await issue(teamA, { projectId: p.id, column: "Done" });
    await issue(teamA, { projectId: p.id });
    for (const id of [top.id, sub.id]) assert.equal((await app("POST", `/api/app/initiatives/${id}/projects`, owner, { body: { projectId: p.id } })).status, 201);
    assert.equal((await app("POST", `/api/app/initiatives/${sub.id}/projects`, owner, { body: { projectId: p.id } })).status, 409);
    const got = (await app("GET", `/api/app/initiatives/${top.id}`, owner)).json.initiative as Initiative;
    assert.deepEqual([got.total, got.done, got.projects.length, got.projectCount, got.childCount], [2, 1, 1, 1, 1]);
    const un = await app("DELETE", `/api/app/initiatives/${top.id}/projects/${p.id}`, owner);
    assert.equal(un.status, 200, un.text);
    assert.equal((await app("GET", `/api/app/projects/${p.id}`, owner)).status, 200);
    assert.equal((un.json.initiative as Initiative).total, 2, "still reached through the sub-initiative");
  });
});

describe("who sees what", () => {
  test("a member sees another team's project inside an initiative only as totals, never a name or an issue", async () => {
    const top = await make({ status: "active" });
    const secret = await project(teamB, "SECRET-PROJECT");
    await issue(teamB, { projectId: secret.id, title: "SECRET-ISSUE", column: "Done" });
    await issue(teamB, { projectId: secret.id, title: "SECRET-ISSUE-2" });
    assert.equal((await app("POST", `/api/app/initiatives/${top.id}/projects`, owner, { body: { projectId: secret.id } })).status, 201);
    const asMember = await app("GET", `/api/app/initiatives/${top.id}`, member);
    assert.equal(asMember.status, 200, asMember.text);
    const seen = asMember.json.initiative as Initiative;
    assert.deepEqual([seen.projects.length, seen.hidden, seen.total, seen.done], [0, { count: 1, total: 2, done: 1 }, 2, 1]);
    const everything = asMember.text + (await app("GET", "/api/app/initiatives", member)).text;
    assert.ok(!everything.includes("SECRET"), "nothing of the other team's project leaks");
    assert.equal((await app("POST", `/api/app/initiatives/${top.id}/projects`, member, { body: { projectId: secret.id } })).status, 403, "and a member who cannot edit it cannot link");
  });

  test("a member cannot change someone else's initiative; a guest sees none", async () => {
    const top = await make();
    assert.equal((await app("PATCH", `/api/app/initiatives/${top.id}`, member, { body: { name: "mine" } })).status, 403);
    assert.equal((await app("DELETE", `/api/app/initiatives/${top.id}`, member)).status, 403);
    const theirs = await make({}, member);
    assert.equal((await app("PATCH", `/api/app/initiatives/${theirs.id}`, member, { body: { name: "mine" } })).status, 200);
    const list = await app("GET", "/api/app/initiatives", guest);
    assert.equal(list.status, 200, list.text);
    assert.deepEqual(list.json.initiatives, []);
    assert.equal((await app("GET", `/api/app/initiatives/${top.id}`, guest)).status, 404);
    assert.equal((await app("POST", "/api/app/initiatives", guest, { body: { name: "no" } })).status, 404);
  });

  test("another workspace cannot see, change or link to any of it", async () => {
    const top = await make();
    const other = (await newAccount("Other")).sess;
    assert.deepEqual((await app("GET", "/api/app/initiatives", other)).json.initiatives, []);
    assert.equal((await app("GET", `/api/app/initiatives/${top.id}`, other)).status, 404);
    assert.equal((await app("PATCH", `/api/app/initiatives/${top.id}`, other, { body: { name: "x" } })).status, 404);
    assert.equal((await app("DELETE", `/api/app/initiatives/${top.id}`, other)).status, 404);
  });

  test("/api/v1 does not grow initiatives", async () => {
    const tools = await v1ok({ key: apiKey }, "list_projects", {});
    assert.ok(!JSON.stringify(tools).includes("initiative"));
  });
});
