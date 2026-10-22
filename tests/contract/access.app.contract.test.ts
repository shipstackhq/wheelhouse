import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { anon, app, newEmail, sessionFrom, type Sess } from "./lib/app";

/**
 * Team isolation over real HTTP (ADR-23): a person reaches a team only as its member, whatever their workspace role.
 * Everything runs in accounts made for the test, so the seeded workspaces stay as they were.
 */
const PW = "a-long-enough-password";
type Person = { email: string; sess: Sess; id: string; role: string };

async function signUp(name: string): Promise<Person> {
  const email = newEmail();
  const r = await app("POST", "/api/app/auth/signup", anon(), { body: { name, email, password: PW, workspace: `${name} workspace` } });
  assert.equal(r.status, 201, r.text);
  return { email, sess: sessionFrom(r), id: r.json.user.id, role: r.json.role };
}
/** The owner invites someone into the workspace with a role, and they accept. */
async function join(owner: Person, name: string, role: string): Promise<Person> {
  const email = newEmail();
  const inv = await app("POST", "/api/app/invites", owner.sess, { body: { kind: "join_workspace", email, role } });
  assert.equal(inv.status, 201, inv.text);
  const r = await app("POST", "/api/app/invites/accept", anon(), { body: { token: inv.json.link.split("#")[1], name, password: PW, confirm: PW } });
  assert.equal(r.status, 201, r.text);
  return { email, sess: sessionFrom(r), id: r.json.user.id, role };
}
let k = 0;
const newKey = () => `X${Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 3).toUpperCase()}${String.fromCharCode(65 + (k++ % 26))}`;
async function makeTeam(by: Person, name: string) {
  const key = newKey();
  const r = await app("POST", "/api/app/teams", by.sess, { body: { name, key } });
  assert.equal(r.status, 201, r.text);
  return key;
}
const members = (p: Person, key: string) => app("GET", `/api/app/teams/${key}/members`, p.sess);
const add = (by: Person, key: string, who: Person, role: string) => app("POST", `/api/app/teams/${key}/members`, by.sess, { body: { userId: who.id, role } });

describe("a team is reachable only by its members", () => {
  test("a member of the workspace, even its owner, cannot open a team made by someone else", async () => {
    const owner = await signUp("Owner");
    const bob = await join(owner, "Bob", "member");
    const bobsKey = await makeTeam(bob, "Bob's");
    // the owner is not in it: not found on every route, the same as a team that does not exist
    for (const [m, path] of [
      ["GET", `/api/app/teams/${bobsKey}/board`],
      ["GET", `/api/app/teams/${bobsKey}/members`],
      ["GET", `/api/app/teams/${bobsKey}/docs`],
      ["GET", `/api/app/teams/${bobsKey}/repositories`],
    ] as const) {
      const r = await app(m, path, owner.sess);
      assert.equal(r.status, 404, `${path}: ${r.text}`);
      assert.equal(r.json.error.code, "not_found");
    }
    const none = await app("GET", "/api/app/teams/NOSUCH/board", owner.sess);
    assert.equal(none.status, 404);
    // the team list shows only your own
    assert.deepEqual((await app("GET", "/api/app/teams", owner.sess)).json.teams, []);
    assert.deepEqual((await app("GET", "/api/app/teams", bob.sess)).json.teams.map((p: { key: string }) => p.key), [bobsKey]);
  });

  test("teams of another workspace are not found either", async () => {
    const a = await signUp("A");
    const b = await signUp("B");
    const key = await makeTeam(a, "A's");
    assert.equal((await app("GET", `/api/app/teams/${key}/board`, b.sess)).status, 404);
    assert.equal((await members(b, key)).status, 404);
  });

  test("signed out is a 401 and a forged request a 403, on every new endpoint", async () => {
    const o = await signUp("Owner");
    const key = await makeTeam(o, "P");
    const sid = "00000000-0000-4000-8000-000000000000";
    for (const [m, path, body] of [
      ["GET", `/api/app/teams/${key}/members`],
      ["GET", `/api/app/teams/${key}/members/addable`],
      ["POST", `/api/app/teams/${key}/members`, { userId: sid, role: "viewer" }],
      ["PATCH", `/api/app/teams/${key}/members/${sid}`, { role: "viewer" }],
      ["DELETE", `/api/app/teams/${key}/members/${sid}`],
      ["POST", `/api/app/teams/${key}/join`, {}],
      ["GET", "/api/app/access/teams"],
      ["GET", "/api/app/access/audit"],
    ] as [string, string, unknown?][]) {
      const out = await app(m, path, anon(), { body });
      assert.equal(out.status, 401, `${m} ${path}`);
    }
    const forged = await app("POST", `/api/app/teams/${key}/members`, o.sess, { body: { userId: sid, role: "viewer" }, origin: "https://evil.example" });
    assert.equal(forged.status, 403);
  });
});

describe("roles inside a team", () => {
  test("viewers read and cannot write; editors write; only admins change who is in", async () => {
    const owner = await signUp("Owner");
    const editor = await join(owner, "Eddie", "member");
    const viewer = await join(owner, "Vic", "member");
    const outsider = await join(owner, "Out", "member");
    const key = await makeTeam(owner, "Workspace team");
    assert.equal((await add(owner, key, editor, "editor")).status, 201);
    assert.equal((await add(owner, key, viewer, "viewer")).status, 201);

    const t = await app("POST", `/api/app/teams/${key}/issues`, editor.sess, { body: { title: "edited by an editor" } });
    assert.equal(t.status, 201, t.text);
    assert.equal((await app("GET", `/api/app/teams/${key}/board`, viewer.sess)).status, 200);
    const blocked = await app("POST", `/api/app/teams/${key}/issues`, viewer.sess, { body: { title: "no" } });
    assert.equal(blocked.status, 403, blocked.text);
    assert.equal(blocked.json.error.code, "forbidden");
    assert.equal((await app("GET", `/api/app/teams/${key}/board`, outsider.sess)).status, 404);

    assert.equal((await add(editor, key, outsider, "viewer")).status, 403); // an editor cannot add people
    assert.equal((await app("GET", `/api/app/teams/${key}/members/addable`, editor.sess)).status, 403);
    assert.equal((await add(owner, key, editor, "viewer")).status, 409); // already in
    const addable = await app("GET", `/api/app/teams/${key}/members/addable`, owner.sess);
    assert.deepEqual(addable.json.people.map((p: { name: string }) => p.name), ["Out"]);
    assert.equal((await add(owner, key, outsider, "viewer")).status, 201);
    assert.equal((await app("GET", `/api/app/teams/${key}/board`, outsider.sess)).status, 200);

    const list = await members(viewer, key);
    assert.equal(list.status, 200);
    assert.equal(list.json.myRole, "viewer");
    assert.deepEqual(list.json.members.map((m: { name: string; role: string }) => [m.name, m.role]), [["Owner", "admin"], ["Eddie", "editor"], ["Vic", "viewer"], ["Out", "viewer"]]);
  });

  test("a team keeps one admin: the last cannot be demoted, removed or leave; a bad role is refused", async () => {
    const owner = await signUp("Owner");
    const bob = await join(owner, "Bob", "member");
    const key = await makeTeam(owner, "Keep one admin");
    await add(owner, key, bob, "editor");
    const demote = await app("PATCH", `/api/app/teams/${key}/members/${owner.id}`, owner.sess, { body: { role: "editor" } });
    assert.equal(demote.status, 409, demote.text);
    assert.equal((await app("DELETE", `/api/app/teams/${key}/members/${owner.id}`, owner.sess)).status, 409);
    assert.equal((await app("PATCH", `/api/app/teams/${key}/members/${bob.id}`, owner.sess, { body: { role: "owner" } })).status, 400);
    assert.equal((await app("PATCH", `/api/app/teams/${key}/members/${bob.id}`, owner.sess, { body: { role: "admin" } })).status, 200);
    assert.equal((await app("PATCH", `/api/app/teams/${key}/members/${owner.id}`, owner.sess, { body: { role: "editor" } })).status, 200); // bob is admin now
    assert.equal((await app("DELETE", `/api/app/teams/${key}/members/${bob.id}`, bob.sess)).status, 409); // bob is the last admin
  });

  test("anyone may leave a team they are not the last admin of, and then cannot open it", async () => {
    const owner = await signUp("Owner");
    const bob = await join(owner, "Bob", "member");
    const key = await makeTeam(owner, "Leave me");
    await add(owner, key, bob, "editor");
    assert.equal((await app("DELETE", `/api/app/teams/${key}/members/${bob.id}`, bob.sess)).status, 200);
    assert.equal((await app("GET", `/api/app/teams/${key}/board`, bob.sess)).status, 404);
  });
});

describe("workspace owners and admins", () => {
  test("see every team by name, join one as admin (audited and visible to its members), and a plain member cannot", async () => {
    const owner = await signUp("Owner");
    const bob = await join(owner, "Bob", "member");
    const key = await makeTeam(bob, "Bob only");

    const all = await app("GET", "/api/app/access/teams", owner.sess);
    assert.equal(all.status, 200);
    const row = all.json.teams.find((p: { key: string }) => p.key === key);
    assert.deepEqual([row.admins, row.isMember], [["Bob"], false]);
    assert.equal((await app("GET", `/api/app/teams/${key}/board`, owner.sess)).status, 404); // a name opens nothing
    assert.equal((await app("GET", "/api/app/access/teams", bob.sess)).status, 403);

    assert.equal((await app("POST", `/api/app/teams/${key}/join`, bob.sess, { body: {} })).status, 403); // a plain member cannot, even of their own team
    const stranger = await join(owner, "Mid", "member");
    assert.equal((await app("POST", `/api/app/teams/${key}/join`, stranger.sess, { body: {} })).status, 403);
    assert.equal((await app("POST", `/api/app/teams/${key}/join`, owner.sess, { body: {} })).status, 200);
    assert.equal((await app("GET", `/api/app/teams/${key}/board`, owner.sess)).status, 200);
    assert.equal((await app("POST", `/api/app/teams/${key}/join`, owner.sess, { body: {} })).status, 409); // already in

    const audit = await app("GET", `/api/app/access/audit?team=${key}`, owner.sess);
    assert.equal(audit.status, 200);
    assert.ok(audit.json.events.some((e: { action: string; actorName: string }) => e.action === "team.admin_joined" && e.actorName === "Owner"));
    assert.equal((await app("GET", "/api/app/access/audit", bob.sess)).status, 403);
  });

  test("removing a person from the workspace is refused while they are a team's only admin", async () => {
    const owner = await signUp("Owner");
    const bob = await join(owner, "Bob", "member");
    const key = await makeTeam(bob, "Bob's only admin");
    const r = await app("DELETE", `/api/app/workspace/members/${bob.id}`, owner.sess);
    assert.equal(r.status, 409, r.text);
    assert.match(r.json.error.message, new RegExp(key));
    await app("POST", `/api/app/teams/${key}/join`, owner.sess, { body: {} });
    assert.equal((await app("DELETE", `/api/app/workspace/members/${bob.id}`, owner.sess)).status, 200);
  });

  test("workspace roles: viewers and guests cannot start teams; an admin invites but cannot make an owner", async () => {
    const owner = await signUp("Owner");
    const viewer = await join(owner, "Vic", "viewer");
    const guest = await join(owner, "Gus", "guest");
    const admin = await join(owner, "Ann", "admin");
    for (const p of [viewer, guest]) assert.equal((await app("POST", "/api/app/teams", p.sess, { body: { name: "No", key: newKey() } })).status, 403);
    const ok = await app("POST", "/api/app/invites", admin.sess, { body: { kind: "join_workspace", email: newEmail(), role: "member" } });
    assert.equal(ok.status, 201, ok.text);
    const owner2 = await app("POST", "/api/app/invites", admin.sess, { body: { kind: "join_workspace", email: newEmail(), role: "owner" } });
    assert.equal(owner2.status, 403, owner2.text);
  });
});

describe("invites that carry teams", () => {
  test("the new person joins exactly the teams chosen, with the chosen role; you cannot hand out a team you do not administer", async () => {
    const owner = await signUp("Owner");
    const mine = await makeTeam(owner, "Handed out");
    const other = await makeTeam(owner, "Kept back");
    const email = newEmail();
    const inv = await app("POST", "/api/app/invites", owner.sess, { body: { kind: "join_workspace", email, role: "member", teams: [{ team: mine, role: "viewer" }] } });
    assert.equal(inv.status, 201, inv.text);
    const pending = await app("GET", "/api/app/invites", owner.sess);
    assert.deepEqual(pending.json.invites.find((i: { email: string }) => i.email === email).teams.map((p: { key: string; role: string }) => [p.key, p.role]), [[mine, "viewer"]]);

    const r = await app("POST", "/api/app/invites/accept", anon(), { body: { token: inv.json.link.split("#")[1], name: "Guest of one", password: PW, confirm: PW } });
    assert.equal(r.status, 201, r.text);
    const person: Person = { email, sess: sessionFrom(r), id: r.json.user.id, role: "member" };
    assert.deepEqual((await app("GET", "/api/app/teams", person.sess)).json.teams.map((p: { key: string; role: string }) => [p.key, p.role]), [[mine, "viewer"]]);
    assert.equal((await app("GET", `/api/app/teams/${mine}/board`, person.sess)).status, 200);
    assert.equal((await app("POST", `/api/app/teams/${mine}/issues`, person.sess, { body: { title: "no" } })).status, 403);
    assert.equal((await app("GET", `/api/app/teams/${other}/board`, person.sess)).status, 404);

    // an admin of the workspace who is in no team cannot give teams away; an unknown team is refused too
    const admin = await join(owner, "Ann", "admin");
    const refused = await app("POST", "/api/app/invites", admin.sess, { body: { kind: "join_workspace", email: newEmail(), role: "member", teams: [{ team: mine, role: "viewer" }] } });
    assert.equal(refused.status, 403, refused.text);
    const unknown = await app("POST", "/api/app/invites", owner.sess, { body: { kind: "join_workspace", email: newEmail(), role: "member", teams: [{ team: "NOSUCH", role: "viewer" }] } });
    assert.equal(unknown.status, 403, unknown.text);
  });
});

describe("one person in several workspaces", () => {
  const me = (p: Person) => app("GET", "/api/app/me", p.sess);

  test("an invite sent to an account's own address adds a second workspace; the session switches between them; nothing leaks across", async () => {
    const pat = await signUp("Pat"); // owner of Pat's workspace
    const zed = await signUp("Zed"); // owner of a second workspace
    const zedsTeam = await makeTeam(zed, "Zed's shared");
    const hidden = await makeTeam(zed, "Zed's private");
    const inv = await app("POST", "/api/app/invites", zed.sess, { body: { kind: "join_workspace", email: pat.email, role: "viewer", teams: [{ team: zedsTeam, role: "editor" }] } });
    assert.equal(inv.status, 201, inv.text);
    const token = inv.json.link.split("#")[1];

    // an account that already exists cannot use the public sign-up flow; only the signed-in one applies, and only for its own address
    const publicTry = await app("POST", "/api/app/invites/accept", anon(), { body: { token, name: "Pat", password: PW, confirm: PW } });
    assert.equal(publicTry.status, 400, publicTry.text);
    const someoneElse = await signUp("Else");
    assert.equal((await app("POST", "/api/app/invites/peek-existing", someoneElse.sess, { body: { token } })).status, 400);
    assert.equal((await app("POST", "/api/app/invites/accept-existing", someoneElse.sess, { body: { token } })).status, 400);
    assert.equal((await app("POST", "/api/app/invites/peek-existing", anon(), { body: { token } })).status, 401);

    const peek = await app("POST", "/api/app/invites/peek-existing", pat.sess, { body: { token } });
    assert.equal(peek.status, 200, peek.text);
    assert.deepEqual([peek.json.invite.workspaceName, peek.json.invite.role], ["Zed workspace", "viewer"]);
    const before = (await me(pat)).json.workspace.id;
    const other = await app("POST", "/api/app/auth/login", anon(), { body: { email: pat.email, password: PW } }); // a second session of the same person
    const otherSess = sessionFrom(other);

    const joined = await app("POST", "/api/app/invites/accept-existing", pat.sess, { body: { token } });
    assert.equal(joined.status, 200, joined.text);
    assert.equal((await app("POST", "/api/app/invites/accept-existing", pat.sess, { body: { token } })).status, 400); // used once

    // this session now works in Zed's workspace, as a viewer, in the one team it was given (the workspace viewer role caps it to read only)
    const now = await me(pat);
    assert.equal(now.json.workspace.name, "Zed workspace");
    assert.equal(now.json.role, "viewer");
    assert.notEqual(now.json.workspace.id, before);
    assert.deepEqual((await app("GET", "/api/app/teams", pat.sess)).json.teams.map((p: { key: string; role: string }) => [p.key, p.role]), [[zedsTeam, "viewer"]]); // given editor, capped to viewer by the workspace role
    assert.equal((await app("GET", `/api/app/teams/${hidden}/board`, pat.sess)).status, 404);
    // the other session of the same person was not moved
    assert.equal((await app("GET", "/api/app/me", { ...pat.sess, cookie: otherSess.cookie, csrf: otherSess.csrf })).json.workspace.id, before);

    const list = await app("GET", "/api/app/me/workspaces", pat.sess);
    assert.deepEqual(list.json.workspaces.map((w: { name: string; active: boolean }) => [w.name, w.active]).sort(), [["Pat workspace", false], ["Zed workspace", true]]);
    // back to the first, and Zed's team is not found from there
    assert.equal((await app("POST", "/api/app/me/workspace", pat.sess, { body: { workspaceId: before } })).status, 200);
    assert.equal((await me(pat)).json.workspace.id, before);
    assert.equal((await app("GET", `/api/app/teams/${zedsTeam}/board`, pat.sess)).status, 404);
    // a workspace you are not in, or no id at all, is a plain 404 and changes nothing
    const strangersWorkspace = (await me(zed)).json.workspace.id === before ? (await me(someoneElse)).json.workspace.id : (await me(someoneElse)).json.workspace.id;
    assert.equal((await app("POST", "/api/app/me/workspace", pat.sess, { body: { workspaceId: strangersWorkspace } })).status, 404);
    assert.equal((await app("POST", "/api/app/me/workspace", pat.sess, { body: {} })).status, 404);
    assert.equal((await me(pat)).json.workspace.id, before);
  });

  test("signed out and forged requests are refused on the workspace endpoints", async () => {
    for (const [m, path, body] of [
      ["GET", "/api/app/me/workspaces"],
      ["POST", "/api/app/me/workspace", { workspaceId: "x" }],
      ["POST", "/api/app/invites/peek-existing", { token: "x" }],
      ["POST", "/api/app/invites/accept-existing", { token: "x" }],
    ] as [string, string, unknown?][]) {
      assert.equal((await app(m, path, anon(), { body })).status, 401, `${m} ${path}`);
    }
    const p = await signUp("Pat");
    assert.equal((await app("POST", "/api/app/me/workspace", p.sess, { body: { workspaceId: "x" }, origin: "https://evil.example" })).status, 403);
  });
});

describe("ids that are not ids", () => {
  test("a malformed id is a plain 404 (or 400), never a server error", async () => {
    const owner = await signUp("Owner");
    const key = await makeTeam(owner, "Garbage in");
    const bad = ["not-a-uuid", "1", "' or 1=1 --", "00000000-0000-0000-0000-00000000000g"];
    for (const id of bad) {
      const e = encodeURIComponent(id);
      for (const [m, path, body] of [
        ["PATCH", `/api/app/teams/${key}/members/${e}`, { role: "viewer" }],
        ["DELETE", `/api/app/teams/${key}/members/${e}`],
        ["PATCH", `/api/app/workspace/members/${e}`, { role: "member" }],
        ["DELETE", `/api/app/workspace/members/${e}`],
      ] as [string, string, unknown?][]) {
        const r = await app(m, path, owner.sess, { body });
        assert.equal(r.status, 404, `${m} ${path}: ${r.status} ${r.text.slice(0, 120)}`);
      }
      const add = await app("POST", `/api/app/teams/${key}/members`, owner.sess, { body: { userId: id, role: "viewer" } });
      assert.equal(add.status, 404, `add ${id}: ${add.status}`);
      const sw = await app("POST", "/api/app/me/workspace", owner.sess, { body: { workspaceId: id } });
      assert.equal(sw.status, 404, `switch ${id}: ${sw.status}`);
    }
    for (const token of ["x", "", "a".repeat(43), "a".repeat(500)]) {
      assert.equal((await app("POST", "/api/app/invites/peek-existing", owner.sess, { body: { token } })).status, 400);
      assert.equal((await app("POST", "/api/app/invites/accept-existing", owner.sess, { body: { token } })).status, 400);
    }
    assert.equal((await app("GET", "/api/app/access/audit?team=%27%20or%201%3D1", owner.sess)).status, 404);
    for (const limit of ["abc", "-5", "0", "1e99", ""]) assert.equal((await app("GET", `/api/app/access/audit?limit=${limit}`, owner.sess)).status, 200, `limit=${limit}`);
  });
});

describe("the per-team dashboard", () => {
  const widget = (p: Person, name: string, query = "") => app("GET", `/api/app/dashboard/${name}${query}`, p.sess);

  test("a team's numbers are its own; the workspace page is unchanged; a person only reads teams they are in", async () => {
    const owner = await signUp("Owner");
    const bob = await join(owner, "Bob", "member");
    const a = await makeTeam(owner, "Alpha");
    const b = await makeTeam(owner, "Beta");
    await add(owner, a, bob, "viewer");
    for (const title of ["a1", "a2"]) assert.equal((await app("POST", `/api/app/teams/${a}/issues`, owner.sess, { body: { title } })).status, 201);
    assert.equal((await app("POST", `/api/app/teams/${b}/issues`, owner.sess, { body: { title: "b1", priority: "urgent" } })).status, 201);

    const all = await widget(owner, "kpis");
    assert.equal(all.status, 200, all.text);
    assert.deepEqual([all.json.teams, all.json.open], [2, 3]);
    const mine = await widget(owner, "kpis", `?team=${a}`);
    assert.deepEqual([mine.json.teams, mine.json.open], [1, 2]);
    assert.deepEqual((await widget(owner, "progress", `?team=${b}`)).json.map((p: { key: string; total: number }) => [p.key, p.total]), [[b, 1]]);
    assert.deepEqual((await widget(owner, "attention", `?team=${a}`)).json.urgent, []); // the urgent issue is in Beta
    assert.equal((await widget(owner, "attention", `?team=${b}`)).json.urgent[0].title, "b1");

    const focus = await widget(owner, "focus", `?team=${a}`);
    assert.equal(focus.status, 200, focus.text);
    assert.deepEqual([focus.json.issues, focus.json.members.count, focus.json.members.myRole], [2, 2, "admin"]);
    assert.equal((await widget(bob, "focus", `?team=${a}`)).json.members.myRole, "viewer");

    // bob is only in Alpha: Beta's dashboard is a plain 404, and his workspace dashboard counts one team
    assert.equal((await widget(bob, "kpis", `?team=${b}`)).status, 404);
    assert.equal((await widget(bob, "focus", `?team=${b}`)).status, 404);
    assert.equal((await widget(bob, "kpis")).json.teams, 1);
  });

  test("another workspace's team, a team that does not exist and malformed values are all plain 404s; Focus needs a team", async () => {
    const x = await signUp("X");
    const y = await signUp("Y");
    const key = await makeTeam(x, "X's");
    for (const name of ["kpis", "progress", "throughput", "activity-split", "agents", "attention", "recent", "sync", "focus"]) {
      assert.equal((await widget(y, name, `?team=${key}`)).status, 404, `${name} reads another workspace's team`);
      for (const bad of ["NOSUCH", "' or 1=1 --", "not-a-uuid", "%00", "A&team=B", "00000000-0000-4000-8000-000000000000"]) {
        const q = bad === "A&team=B" ? "?team=A&team=B" : `?team=${encodeURIComponent(bad)}`;
        const r = await widget(x, name, q);
        assert.equal(r.status, 404, `${name} ${bad}: ${r.status} ${r.text.slice(0, 80)}`);
      }
    }
    assert.equal((await widget(x, "focus")).status, 404); // Focus is only for one team
    assert.equal((await widget(x, "nonsense", `?team=${key}`)).status, 404);
    assert.equal((await app("GET", `/api/app/dashboard/kpis?team=${key}`, anon())).status, 401);
    for (const name of ["kpis", "focus"]) assert.equal((await widget(x, name, "?team=")).status, name === "focus" ? 404 : 200, `${name} with an empty team`); // empty means "the workspace"
  });
});
