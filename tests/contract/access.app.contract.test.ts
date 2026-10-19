import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { anon, app, newEmail, sessionFrom, type Sess } from "./lib/app";

/**
 * Project isolation over real HTTP (ADR-23): a person reaches a project only as its member, whatever their workspace role.
 * Everything runs in accounts made for the test, so the seeded teams stay as they were.
 */
const PW = "a-long-enough-password";
type Person = { email: string; sess: Sess; id: string; role: string };

async function signUp(name: string): Promise<Person> {
  const email = newEmail();
  const r = await app("POST", "/api/app/auth/signup", anon(), { body: { name, email, password: PW, team: `${name} team` } });
  assert.equal(r.status, 201, r.text);
  return { email, sess: sessionFrom(r), id: r.json.user.id, role: r.json.role };
}
/** The owner invites someone into the workspace with a role, and they accept. */
async function join(owner: Person, name: string, role: string): Promise<Person> {
  const email = newEmail();
  const inv = await app("POST", "/api/app/invites", owner.sess, { body: { kind: "join_team", email, role } });
  assert.equal(inv.status, 201, inv.text);
  const r = await app("POST", "/api/app/invites/accept", anon(), { body: { token: inv.json.link.split("#")[1], name, password: PW, confirm: PW } });
  assert.equal(r.status, 201, r.text);
  return { email, sess: sessionFrom(r), id: r.json.user.id, role };
}
let k = 0;
const newKey = () => `X${Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 3).toUpperCase()}${String.fromCharCode(65 + (k++ % 26))}`;
async function makeProject(by: Person, name: string) {
  const key = newKey();
  const r = await app("POST", "/api/app/projects", by.sess, { body: { name, key } });
  assert.equal(r.status, 201, r.text);
  return key;
}
const members = (p: Person, key: string) => app("GET", `/api/app/projects/${key}/members`, p.sess);
const add = (by: Person, key: string, who: Person, role: string) => app("POST", `/api/app/projects/${key}/members`, by.sess, { body: { userId: who.id, role } });

describe("a project is reachable only by its members", () => {
  test("a member of the workspace, even its owner, cannot open a project made by someone else", async () => {
    const owner = await signUp("Owner");
    const bob = await join(owner, "Bob", "member");
    const bobsKey = await makeProject(bob, "Bob's");
    // the owner is not in it: not found on every route, the same as a project that does not exist
    for (const [m, path] of [
      ["GET", `/api/app/projects/${bobsKey}/board`],
      ["GET", `/api/app/projects/${bobsKey}/members`],
      ["GET", `/api/app/projects/${bobsKey}/docs`],
      ["GET", `/api/app/projects/${bobsKey}/repositories`],
    ] as const) {
      const r = await app(m, path, owner.sess);
      assert.equal(r.status, 404, `${path}: ${r.text}`);
      assert.equal(r.json.error.code, "not_found");
    }
    const none = await app("GET", "/api/app/projects/NOSUCH/board", owner.sess);
    assert.equal(none.status, 404);
    // the project list shows only your own
    assert.deepEqual((await app("GET", "/api/app/projects", owner.sess)).json.projects, []);
    assert.deepEqual((await app("GET", "/api/app/projects", bob.sess)).json.projects.map((p: { key: string }) => p.key), [bobsKey]);
  });

  test("projects of another workspace are not found either", async () => {
    const a = await signUp("A");
    const b = await signUp("B");
    const key = await makeProject(a, "A's");
    assert.equal((await app("GET", `/api/app/projects/${key}/board`, b.sess)).status, 404);
    assert.equal((await members(b, key)).status, 404);
  });

  test("signed out is a 401 and a forged request a 403, on every new endpoint", async () => {
    const o = await signUp("Owner");
    const key = await makeProject(o, "P");
    const sid = "00000000-0000-4000-8000-000000000000";
    for (const [m, path, body] of [
      ["GET", `/api/app/projects/${key}/members`],
      ["GET", `/api/app/projects/${key}/members/addable`],
      ["POST", `/api/app/projects/${key}/members`, { userId: sid, role: "viewer" }],
      ["PATCH", `/api/app/projects/${key}/members/${sid}`, { role: "viewer" }],
      ["DELETE", `/api/app/projects/${key}/members/${sid}`],
      ["POST", `/api/app/projects/${key}/join`, {}],
      ["GET", "/api/app/access/projects"],
      ["GET", "/api/app/access/audit"],
    ] as [string, string, unknown?][]) {
      const out = await app(m, path, anon(), { body });
      assert.equal(out.status, 401, `${m} ${path}`);
    }
    const forged = await app("POST", `/api/app/projects/${key}/members`, o.sess, { body: { userId: sid, role: "viewer" }, origin: "https://evil.example" });
    assert.equal(forged.status, 403);
  });
});

describe("roles inside a project", () => {
  test("viewers read and cannot write; editors write; only admins change who is in", async () => {
    const owner = await signUp("Owner");
    const editor = await join(owner, "Eddie", "member");
    const viewer = await join(owner, "Vic", "member");
    const outsider = await join(owner, "Out", "member");
    const key = await makeProject(owner, "Team project");
    assert.equal((await add(owner, key, editor, "editor")).status, 201);
    assert.equal((await add(owner, key, viewer, "viewer")).status, 201);

    const t = await app("POST", `/api/app/projects/${key}/tickets`, editor.sess, { body: { title: "edited by an editor" } });
    assert.equal(t.status, 201, t.text);
    assert.equal((await app("GET", `/api/app/projects/${key}/board`, viewer.sess)).status, 200);
    const blocked = await app("POST", `/api/app/projects/${key}/tickets`, viewer.sess, { body: { title: "no" } });
    assert.equal(blocked.status, 403, blocked.text);
    assert.equal(blocked.json.error.code, "forbidden");
    assert.equal((await app("GET", `/api/app/projects/${key}/board`, outsider.sess)).status, 404);

    assert.equal((await add(editor, key, outsider, "viewer")).status, 403); // an editor cannot add people
    assert.equal((await app("GET", `/api/app/projects/${key}/members/addable`, editor.sess)).status, 403);
    assert.equal((await add(owner, key, editor, "viewer")).status, 409); // already in
    const addable = await app("GET", `/api/app/projects/${key}/members/addable`, owner.sess);
    assert.deepEqual(addable.json.people.map((p: { name: string }) => p.name), ["Out"]);
    assert.equal((await add(owner, key, outsider, "viewer")).status, 201);
    assert.equal((await app("GET", `/api/app/projects/${key}/board`, outsider.sess)).status, 200);

    const list = await members(viewer, key);
    assert.equal(list.status, 200);
    assert.equal(list.json.myRole, "viewer");
    assert.deepEqual(list.json.members.map((m: { name: string; role: string }) => [m.name, m.role]), [["Owner", "admin"], ["Eddie", "editor"], ["Vic", "viewer"], ["Out", "viewer"]]);
  });

  test("a project keeps one admin: the last cannot be demoted, removed or leave; a bad role is refused", async () => {
    const owner = await signUp("Owner");
    const bob = await join(owner, "Bob", "member");
    const key = await makeProject(owner, "Keep one admin");
    await add(owner, key, bob, "editor");
    const demote = await app("PATCH", `/api/app/projects/${key}/members/${owner.id}`, owner.sess, { body: { role: "editor" } });
    assert.equal(demote.status, 409, demote.text);
    assert.equal((await app("DELETE", `/api/app/projects/${key}/members/${owner.id}`, owner.sess)).status, 409);
    assert.equal((await app("PATCH", `/api/app/projects/${key}/members/${bob.id}`, owner.sess, { body: { role: "owner" } })).status, 400);
    assert.equal((await app("PATCH", `/api/app/projects/${key}/members/${bob.id}`, owner.sess, { body: { role: "admin" } })).status, 200);
    assert.equal((await app("PATCH", `/api/app/projects/${key}/members/${owner.id}`, owner.sess, { body: { role: "editor" } })).status, 200); // bob is admin now
    assert.equal((await app("DELETE", `/api/app/projects/${key}/members/${bob.id}`, bob.sess)).status, 409); // bob is the last admin
  });

  test("anyone may leave a project they are not the last admin of, and then cannot open it", async () => {
    const owner = await signUp("Owner");
    const bob = await join(owner, "Bob", "member");
    const key = await makeProject(owner, "Leave me");
    await add(owner, key, bob, "editor");
    assert.equal((await app("DELETE", `/api/app/projects/${key}/members/${bob.id}`, bob.sess)).status, 200);
    assert.equal((await app("GET", `/api/app/projects/${key}/board`, bob.sess)).status, 404);
  });
});

describe("workspace owners and admins", () => {
  test("see every project by name, join one as admin (audited and visible to its members), and a plain member cannot", async () => {
    const owner = await signUp("Owner");
    const bob = await join(owner, "Bob", "member");
    const key = await makeProject(bob, "Bob only");

    const all = await app("GET", "/api/app/access/projects", owner.sess);
    assert.equal(all.status, 200);
    const row = all.json.projects.find((p: { key: string }) => p.key === key);
    assert.deepEqual([row.admins, row.isMember], [["Bob"], false]);
    assert.equal((await app("GET", `/api/app/projects/${key}/board`, owner.sess)).status, 404); // a name opens nothing
    assert.equal((await app("GET", "/api/app/access/projects", bob.sess)).status, 403);

    assert.equal((await app("POST", `/api/app/projects/${key}/join`, bob.sess, { body: {} })).status, 403); // a plain member cannot, even of their own project
    const stranger = await join(owner, "Mid", "member");
    assert.equal((await app("POST", `/api/app/projects/${key}/join`, stranger.sess, { body: {} })).status, 403);
    assert.equal((await app("POST", `/api/app/projects/${key}/join`, owner.sess, { body: {} })).status, 200);
    assert.equal((await app("GET", `/api/app/projects/${key}/board`, owner.sess)).status, 200);
    assert.equal((await app("POST", `/api/app/projects/${key}/join`, owner.sess, { body: {} })).status, 409); // already in

    const audit = await app("GET", `/api/app/access/audit?project=${key}`, owner.sess);
    assert.equal(audit.status, 200);
    assert.ok(audit.json.events.some((e: { action: string; actorName: string }) => e.action === "project.admin_joined" && e.actorName === "Owner"));
    assert.equal((await app("GET", "/api/app/access/audit", bob.sess)).status, 403);
  });

  test("removing a person from the workspace is refused while they are a project's only admin", async () => {
    const owner = await signUp("Owner");
    const bob = await join(owner, "Bob", "member");
    const key = await makeProject(bob, "Bob's only admin");
    const r = await app("DELETE", `/api/app/team/members/${bob.id}`, owner.sess);
    assert.equal(r.status, 409, r.text);
    assert.match(r.json.error.message, new RegExp(key));
    await app("POST", `/api/app/projects/${key}/join`, owner.sess, { body: {} });
    assert.equal((await app("DELETE", `/api/app/team/members/${bob.id}`, owner.sess)).status, 200);
  });

  test("workspace roles: viewers and guests cannot start projects; an admin invites but cannot make an owner", async () => {
    const owner = await signUp("Owner");
    const viewer = await join(owner, "Vic", "viewer");
    const guest = await join(owner, "Gus", "guest");
    const admin = await join(owner, "Ann", "admin");
    for (const p of [viewer, guest]) assert.equal((await app("POST", "/api/app/projects", p.sess, { body: { name: "No", key: newKey() } })).status, 403);
    const ok = await app("POST", "/api/app/invites", admin.sess, { body: { kind: "join_team", email: newEmail(), role: "member" } });
    assert.equal(ok.status, 201, ok.text);
    const owner2 = await app("POST", "/api/app/invites", admin.sess, { body: { kind: "join_team", email: newEmail(), role: "owner" } });
    assert.equal(owner2.status, 403, owner2.text);
  });
});

describe("invites that carry projects", () => {
  test("the new person joins exactly the projects chosen, with the chosen role; you cannot hand out a project you do not administer", async () => {
    const owner = await signUp("Owner");
    const mine = await makeProject(owner, "Handed out");
    const other = await makeProject(owner, "Kept back");
    const email = newEmail();
    const inv = await app("POST", "/api/app/invites", owner.sess, { body: { kind: "join_team", email, role: "member", projects: [{ project: mine, role: "viewer" }] } });
    assert.equal(inv.status, 201, inv.text);
    const pending = await app("GET", "/api/app/invites", owner.sess);
    assert.deepEqual(pending.json.invites.find((i: { email: string }) => i.email === email).projects.map((p: { key: string; role: string }) => [p.key, p.role]), [[mine, "viewer"]]);

    const r = await app("POST", "/api/app/invites/accept", anon(), { body: { token: inv.json.link.split("#")[1], name: "Guest of one", password: PW, confirm: PW } });
    assert.equal(r.status, 201, r.text);
    const person: Person = { email, sess: sessionFrom(r), id: r.json.user.id, role: "member" };
    assert.deepEqual((await app("GET", "/api/app/projects", person.sess)).json.projects.map((p: { key: string; role: string }) => [p.key, p.role]), [[mine, "viewer"]]);
    assert.equal((await app("GET", `/api/app/projects/${mine}/board`, person.sess)).status, 200);
    assert.equal((await app("POST", `/api/app/projects/${mine}/tickets`, person.sess, { body: { title: "no" } })).status, 403);
    assert.equal((await app("GET", `/api/app/projects/${other}/board`, person.sess)).status, 404);

    // an admin of the workspace who is in no project cannot give projects away; an unknown project is refused too
    const admin = await join(owner, "Ann", "admin");
    const refused = await app("POST", "/api/app/invites", admin.sess, { body: { kind: "join_team", email: newEmail(), role: "member", projects: [{ project: mine, role: "viewer" }] } });
    assert.equal(refused.status, 403, refused.text);
    const unknown = await app("POST", "/api/app/invites", owner.sess, { body: { kind: "join_team", email: newEmail(), role: "member", projects: [{ project: "NOSUCH", role: "viewer" }] } });
    assert.equal(unknown.status, 403, unknown.text);
  });
});

describe("one person in several workspaces", () => {
  const me = (p: Person) => app("GET", "/api/app/me", p.sess);

  test("an invite sent to an account's own address adds a second workspace; the session switches between them; nothing leaks across", async () => {
    const pat = await signUp("Pat"); // owner of Pat's workspace
    const zed = await signUp("Zed"); // owner of a second workspace
    const zedsProject = await makeProject(zed, "Zed's shared");
    const hidden = await makeProject(zed, "Zed's private");
    const inv = await app("POST", "/api/app/invites", zed.sess, { body: { kind: "join_team", email: pat.email, role: "viewer", projects: [{ project: zedsProject, role: "editor" }] } });
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
    assert.deepEqual([peek.json.invite.teamName, peek.json.invite.role], ["Zed team", "viewer"]);
    const before = (await me(pat)).json.team.id;
    const other = await app("POST", "/api/app/auth/login", anon(), { body: { email: pat.email, password: PW } }); // a second session of the same person
    const otherSess = sessionFrom(other);

    const joined = await app("POST", "/api/app/invites/accept-existing", pat.sess, { body: { token } });
    assert.equal(joined.status, 200, joined.text);
    assert.equal((await app("POST", "/api/app/invites/accept-existing", pat.sess, { body: { token } })).status, 400); // used once

    // this session now works in Zed's workspace, as a viewer, in the one project it was given (the workspace viewer role caps it to read only)
    const now = await me(pat);
    assert.equal(now.json.team.name, "Zed team");
    assert.equal(now.json.role, "viewer");
    assert.notEqual(now.json.team.id, before);
    assert.deepEqual((await app("GET", "/api/app/projects", pat.sess)).json.projects.map((p: { key: string; role: string }) => [p.key, p.role]), [[zedsProject, "viewer"]]); // given editor, capped to viewer by the workspace role
    assert.equal((await app("GET", `/api/app/projects/${hidden}/board`, pat.sess)).status, 404);
    // the other session of the same person was not moved
    assert.equal((await app("GET", "/api/app/me", { ...pat.sess, cookie: otherSess.cookie, csrf: otherSess.csrf })).json.team.id, before);

    const list = await app("GET", "/api/app/me/workspaces", pat.sess);
    assert.deepEqual(list.json.workspaces.map((w: { name: string; active: boolean }) => [w.name, w.active]).sort(), [["Pat team", false], ["Zed team", true]]);
    // back to the first, and Zed's project is not found from there
    assert.equal((await app("POST", "/api/app/me/workspace", pat.sess, { body: { teamId: before } })).status, 200);
    assert.equal((await me(pat)).json.team.id, before);
    assert.equal((await app("GET", `/api/app/projects/${zedsProject}/board`, pat.sess)).status, 404);
    // a workspace you are not in, or no id at all, is a plain 404 and changes nothing
    const strangersTeam = (await me(zed)).json.team.id === before ? (await me(someoneElse)).json.team.id : (await me(someoneElse)).json.team.id;
    assert.equal((await app("POST", "/api/app/me/workspace", pat.sess, { body: { teamId: strangersTeam } })).status, 404);
    assert.equal((await app("POST", "/api/app/me/workspace", pat.sess, { body: {} })).status, 404);
    assert.equal((await me(pat)).json.team.id, before);
  });

  test("signed out and forged requests are refused on the workspace endpoints", async () => {
    for (const [m, path, body] of [
      ["GET", "/api/app/me/workspaces"],
      ["POST", "/api/app/me/workspace", { teamId: "x" }],
      ["POST", "/api/app/invites/peek-existing", { token: "x" }],
      ["POST", "/api/app/invites/accept-existing", { token: "x" }],
    ] as [string, string, unknown?][]) {
      assert.equal((await app(m, path, anon(), { body })).status, 401, `${m} ${path}`);
    }
    const p = await signUp("Pat");
    assert.equal((await app("POST", "/api/app/me/workspace", p.sess, { body: { teamId: "x" }, origin: "https://evil.example" })).status, 403);
  });
});

describe("ids that are not ids", () => {
  test("a malformed id is a plain 404 (or 400), never a server error", async () => {
    const owner = await signUp("Owner");
    const key = await makeProject(owner, "Garbage in");
    const bad = ["not-a-uuid", "1", "' or 1=1 --", "00000000-0000-0000-0000-00000000000g"];
    for (const id of bad) {
      const e = encodeURIComponent(id);
      for (const [m, path, body] of [
        ["PATCH", `/api/app/projects/${key}/members/${e}`, { role: "viewer" }],
        ["DELETE", `/api/app/projects/${key}/members/${e}`],
        ["PATCH", `/api/app/team/members/${e}`, { role: "member" }],
        ["DELETE", `/api/app/team/members/${e}`],
      ] as [string, string, unknown?][]) {
        const r = await app(m, path, owner.sess, { body });
        assert.equal(r.status, 404, `${m} ${path}: ${r.status} ${r.text.slice(0, 120)}`);
      }
      const add = await app("POST", `/api/app/projects/${key}/members`, owner.sess, { body: { userId: id, role: "viewer" } });
      assert.equal(add.status, 404, `add ${id}: ${add.status}`);
      const sw = await app("POST", "/api/app/me/workspace", owner.sess, { body: { teamId: id } });
      assert.equal(sw.status, 404, `switch ${id}: ${sw.status}`);
    }
    for (const token of ["x", "", "a".repeat(43), "a".repeat(500)]) {
      assert.equal((await app("POST", "/api/app/invites/peek-existing", owner.sess, { body: { token } })).status, 400);
      assert.equal((await app("POST", "/api/app/invites/accept-existing", owner.sess, { body: { token } })).status, 400);
    }
    assert.equal((await app("GET", "/api/app/access/audit?project=%27%20or%201%3D1", owner.sess)).status, 404);
    for (const limit of ["abc", "-5", "0", "1e99", ""]) assert.equal((await app("GET", `/api/app/access/audit?limit=${limit}`, owner.sess)).status, 200, `limit=${limit}`);
  });
});

describe("the per-project dashboard", () => {
  const widget = (p: Person, name: string, query = "") => app("GET", `/api/app/dashboard/${name}${query}`, p.sess);

  test("a project's numbers are its own; the workspace page is unchanged; a person only reads projects they are in", async () => {
    const owner = await signUp("Owner");
    const bob = await join(owner, "Bob", "member");
    const a = await makeProject(owner, "Alpha");
    const b = await makeProject(owner, "Beta");
    await add(owner, a, bob, "viewer");
    for (const title of ["a1", "a2"]) assert.equal((await app("POST", `/api/app/projects/${a}/tickets`, owner.sess, { body: { title } })).status, 201);
    assert.equal((await app("POST", `/api/app/projects/${b}/tickets`, owner.sess, { body: { title: "b1", priority: "urgent" } })).status, 201);

    const all = await widget(owner, "kpis");
    assert.equal(all.status, 200, all.text);
    assert.deepEqual([all.json.projects, all.json.open], [2, 3]);
    const mine = await widget(owner, "kpis", `?project=${a}`);
    assert.deepEqual([mine.json.projects, mine.json.open], [1, 2]);
    assert.deepEqual((await widget(owner, "progress", `?project=${b}`)).json.map((p: { key: string; total: number }) => [p.key, p.total]), [[b, 1]]);
    assert.deepEqual((await widget(owner, "attention", `?project=${a}`)).json.urgent, []); // the urgent ticket is in Beta
    assert.equal((await widget(owner, "attention", `?project=${b}`)).json.urgent[0].title, "b1");

    const focus = await widget(owner, "focus", `?project=${a}`);
    assert.equal(focus.status, 200, focus.text);
    assert.deepEqual([focus.json.tickets, focus.json.members.count, focus.json.members.myRole], [2, 2, "admin"]);
    assert.equal((await widget(bob, "focus", `?project=${a}`)).json.members.myRole, "viewer");

    // bob is only in Alpha: Beta's dashboard is a plain 404, and his workspace dashboard counts one project
    assert.equal((await widget(bob, "kpis", `?project=${b}`)).status, 404);
    assert.equal((await widget(bob, "focus", `?project=${b}`)).status, 404);
    assert.equal((await widget(bob, "kpis")).json.projects, 1);
  });

  test("another workspace's project, a project that does not exist and malformed values are all plain 404s; Focus needs a project", async () => {
    const x = await signUp("X");
    const y = await signUp("Y");
    const key = await makeProject(x, "X's");
    for (const name of ["kpis", "progress", "throughput", "activity-split", "agents", "attention", "recent", "sync", "focus"]) {
      assert.equal((await widget(y, name, `?project=${key}`)).status, 404, `${name} reads another workspace's project`);
      for (const bad of ["NOSUCH", "' or 1=1 --", "not-a-uuid", "%00", "A&project=B", "00000000-0000-4000-8000-000000000000"]) {
        const q = bad === "A&project=B" ? "?project=A&project=B" : `?project=${encodeURIComponent(bad)}`;
        const r = await widget(x, name, q);
        assert.equal(r.status, 404, `${name} ${bad}: ${r.status} ${r.text.slice(0, 80)}`);
      }
    }
    assert.equal((await widget(x, "focus")).status, 404); // Focus is only for one project
    assert.equal((await widget(x, "nonsense", `?project=${key}`)).status, 404);
    assert.equal((await app("GET", `/api/app/dashboard/kpis?project=${key}`, anon())).status, 401);
    for (const name of ["kpis", "focus"]) assert.equal((await widget(x, name, "?project=")).status, name === "focus" ? 404 : 200, `${name} with an empty project`); // empty means "the workspace"
  });
});
