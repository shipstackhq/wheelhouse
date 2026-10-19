import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fx, freshIp, v1 } from "./lib/http";
import { anon, app, login, newEmail, sessionFrom, signIn, type Sess } from "./lib/app";

/**
 * The endpoints behind the dashboard, team, agents, admin, new-project, sign-in and invite pages (WH-95): each one's happy path,
 * signed out, another team's data, a forged request, and the rules the old server actions had (owner-only, limits, one-time secrets).
 * Anything that changes data does it in an account made for the test, so the seeded teams stay as they were.
 */
const PW = "a-long-enough-password";

type Person = { email: string; sess: Sess; me: { user: { id: string }; team: { id: string }; role: string } };

async function signUp(name = "Owner"): Promise<Person> {
  const email = newEmail();
  const r = await app("POST", "/api/app/auth/signup", anon(), { body: { name, email, password: PW, team: `${name} team` } });
  assert.equal(r.status, 201, r.text);
  return { email, sess: sessionFrom(r), me: r.json };
}

/** An owner invites someone by email and they accept, so the test has a real second member of a real team. */
async function addMember(owner: Person, over: { role?: string; tags?: string } = {}): Promise<Person> {
  const email = newEmail();
  const inv = await app("POST", "/api/app/invites", owner.sess, { body: { kind: "join_team", email, role: over.role ?? "member", tags: over.tags } });
  assert.equal(inv.status, 201, inv.text);
  const token = inv.json.link.split("#")[1];
  const r = await app("POST", "/api/app/invites/accept", anon(), { body: { token, name: "Member", password: PW, confirm: PW } });
  assert.equal(r.status, 201, r.text);
  return { email, sess: sessionFrom(r), me: r.json };
}

describe("every endpoint needs a signed-in person", () => {
  const sid = "00000000-0000-4000-8000-000000000000";
  const table: [string, string, unknown?][] = [
    ["GET", "/api/app/team"],
    ["PATCH", `/api/app/team/members/${sid}`, { role: "member" }],
    ["DELETE", `/api/app/team/members/${sid}`],
    ["POST", "/api/app/me/password", { current: PW, next: PW + "x" }],
    ["GET", "/api/app/agents"],
    ["POST", "/api/app/agents/mark-all-seen", {}],
    ["POST", "/api/app/keys", { name: "x" }],
    ["DELETE", `/api/app/keys/${sid}`],
    ["PATCH", `/api/app/keys/${sid}`, { docsWrite: true }],
    ["GET", "/api/app/invites"],
    ["POST", "/api/app/invites", { kind: "join_team", email: "x@example.test" }],
    ["DELETE", `/api/app/invites/${sid}`],
    ["GET", "/api/app/admin/teams"],
    ["GET", `/api/app/admin/teams/${sid}`],
    ["POST", `/api/app/admin/teams/${sid}/suspend`, { confirm: "x" }],
    ["POST", `/api/app/admin/teams/${sid}/restore`, {}],
    ["POST", "/api/app/projects", { name: "x" }],
    ["DELETE", `/api/app/projects/${fx.a.projectKey}/sessions/${sid}`],
    ["GET", "/api/app/dashboard/kpis"],
  ];
  for (const [method, path, body] of table) {
    test(`${method} ${path.replace(sid, ":id")}: 401 as JSON, never a redirect`, async () => {
      const r = await app(method, path, anon(), { body });
      assert.equal(r.status, 401);
      assert.equal(r.json.error.code, "unauthorized");
    });
  }
});

describe("a forged request is refused before anything happens", () => {
  test("a key cannot be created, a member removed or a project made from another site or without the token", async () => {
    const o = await signUp();
    const m = await addMember(o);
    const forged = [
      { origin: "https://evil.example" },
      { csrf: null },
      { csrf: "not-the-token" },
    ];
    for (const f of forged) {
      for (const [method, path, body] of [
        ["POST", "/api/app/keys", { name: "forged" }],
        ["DELETE", `/api/app/team/members/${m.me.user.id}`, undefined],
        ["POST", "/api/app/projects", { name: "Forged" }],
        ["POST", "/api/app/me/password", { current: PW, next: PW + "!" }],
      ] as const) {
        const r = await app(method, path, o.sess, { ...f, body });
        assert.equal(r.status, 403, `${method} ${path} ${JSON.stringify(f)}`);
        assert.equal(r.json.error.code, "csrf_failed");
      }
    }
    const team = await app("GET", "/api/app/team", o.sess);
    assert.equal(team.json.members.length, 2, "nobody was removed");
    assert.equal((await app("GET", "/api/app/agents", o.sess)).json.keys.length, 0, "no key was made");
    assert.deepEqual((await app("GET", "/api/app/projects", o.sess)).json, { projects: [] });
    assert.equal((await login(o.email)).status, 401, "the password was not changed");
    assert.equal((await login(o.email, PW)).status, 200);
  });

  test("the public invite endpoints still need the anonymous token", async () => {
    for (const path of ["/api/app/invites/peek", "/api/app/invites/accept"]) {
      const r = await app("POST", path, anon(), { csrf: null, body: { token: "x" } });
      assert.equal(r.status, 403, path);
      assert.equal(r.json.error.code, "csrf_failed");
    }
  });
});

describe("the team page", () => {
  test("members, roles, tags and seats; only an owner sees the pending invites", async () => {
    const o = await signUp("Ada Lovelace");
    const m = await addMember(o, { tags: "Design, UX" });
    await app("POST", "/api/app/invites", o.sess, { body: { kind: "join_team", email: newEmail() } });
    const owner = await app("GET", "/api/app/team", o.sess);
    assert.equal(owner.status, 200);
    assert.deepEqual(Object.keys(owner.json).sort(), ["members", "pendingInvites", "role", "seats", "team"]);
    assert.equal(owner.json.team.id, o.me.team.id);
    assert.equal(owner.json.role, "owner");
    assert.deepEqual(owner.json.members.map((x: { role: string }) => x.role).sort(), ["member", "owner"]);
    assert.deepEqual(owner.json.members.find((x: { userId: string }) => x.userId === m.me.user.id).tags, ["design", "ux"]);
    assert.deepEqual(owner.json.seats, { members: 2, pending: 1, used: 3, max: owner.json.seats.max, full: false });
    assert.equal(owner.json.pendingInvites.length, 1);
    assert.ok(!owner.text.includes("passwordHash") && !owner.text.includes("password_hash"));

    const member = await app("GET", "/api/app/team", m.sess);
    assert.equal(member.json.role, "member");
    assert.deepEqual(member.json.pendingInvites, [], "a member does not see invites");
  });

  test("it never shows another team's people", async () => {
    const r = await app("GET", "/api/app/team", await signIn(fx.a.email));
    assert.equal(r.json.team.id, fx.a.teamId);
    assert.ok(r.json.members.every((x: { email: string }) => x.email.startsWith("ct-a-")), "only team A");
  });

  test("an owner changes a member's role and tags; tags are lower-cased; a list works too", async () => {
    const o = await signUp();
    const m = await addMember(o);
    const a = await app("PATCH", `/api/app/team/members/${m.me.user.id}`, o.sess, { body: { role: "owner", tags: " Backend, Lead " } });
    assert.equal(a.status, 200);
    assert.deepEqual(a.json.member, { userId: m.me.user.id, name: "Member", email: m.email, role: "owner", tags: ["backend", "lead"] });
    const b = await app("PATCH", `/api/app/team/members/${m.me.user.id}`, o.sess, { body: { role: "member", tags: ["QA"] } });
    assert.deepEqual(b.json.member.tags, ["qa"]);
    assert.equal((await app("GET", "/api/app/me", m.sess)).json.role, "member");
  });

  test("a member may not change or remove anyone: 403, nothing changes", async () => {
    const o = await signUp();
    const m = await addMember(o);
    const p = await app("PATCH", `/api/app/team/members/${o.me.user.id}`, m.sess, { body: { role: "member", tags: [] } });
    assert.equal(p.status, 403);
    assert.equal(p.json.error.code, "forbidden");
    assert.equal((await app("DELETE", `/api/app/team/members/${o.me.user.id}`, m.sess)).status, 403);
    assert.equal((await app("GET", "/api/app/team", o.sess)).json.members.length, 2);
  });

  test("a person from another team is not found: 404, and they are untouched", async () => {
    const o = await signUp();
    const other = await signUp("Other");
    const patch = await app("PATCH", `/api/app/team/members/${other.me.user.id}`, o.sess, { body: { role: "member", tags: ["pwned"] } });
    assert.equal(patch.status, 404);
    assert.equal(patch.json.error.code, "not_found");
    assert.equal((await app("DELETE", `/api/app/team/members/${other.me.user.id}`, o.sess)).status, 404);
    const theirs = await app("GET", "/api/app/team", other.sess);
    assert.deepEqual(theirs.json.members.map((x: { tags: string[] }) => x.tags), [[]]);
    assert.equal(theirs.json.members.length, 1);
  });

  test("the last owner cannot be demoted (409) or remove themselves (400); a bad role is a field error", async () => {
    const o = await signUp();
    const demote = await app("PATCH", `/api/app/team/members/${o.me.user.id}`, o.sess, { body: { role: "member", tags: [] } });
    assert.equal(demote.status, 409);
    assert.equal(demote.json.error.code, "conflict");
    const self = await app("DELETE", `/api/app/team/members/${o.me.user.id}`, o.sess);
    assert.equal(self.status, 400);
    const bad = await app("PATCH", `/api/app/team/members/${o.me.user.id}`, o.sess, { body: { role: "root", tags: [] } });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.json.error.details, { fields: { role: "Choose a role" } });
  });

  test("an owner removes a member, who can then no longer use the team", async () => {
    const o = await signUp();
    const m = await addMember(o);
    const r = await app("DELETE", `/api/app/team/members/${m.me.user.id}`, o.sess);
    assert.deepEqual(r.json, { ok: true });
    assert.equal((await app("GET", "/api/app/team", o.sess)).json.members.length, 1);
    assert.equal((await app("GET", "/api/app/team", m.sess)).status, 401, "a removed member has no team, so no session");
  });
});

describe("POST /api/app/me/password", () => {
  test("needs the current password and a strong new one; then only the new one signs in", async () => {
    const p = await signUp();
    const wrong = await app("POST", "/api/app/me/password", p.sess, { body: { current: "not the password", next: "another long passphrase" } });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.json.error.message, "Current password is wrong");
    assert.equal(wrong.json.error.details.fields.current, "Current password is wrong");
    const weak = await app("POST", "/api/app/me/password", p.sess, { body: { current: PW, next: "short" } });
    assert.equal(weak.status, 400);
    assert.equal(weak.json.error.message, "Password must be at least 12 characters");
    assert.ok(weak.json.error.details.fields.next);
    const ok = await app("POST", "/api/app/me/password", p.sess, { body: { current: PW, next: "another long passphrase" } });
    assert.deepEqual(ok.json, { ok: true });
    assert.equal((await login(p.email, PW)).status, 401);
    assert.equal((await login(p.email, "another long passphrase")).status, 200);
  });
});

describe("API keys and the Agents page", () => {
  test("the secret is in the creation response only; the page lists names and prefixes, never values", async () => {
    const p = await signUp();
    const created = await app("POST", "/api/app/keys", p.sess, { body: { name: "  CI bot " } });
    assert.equal(created.status, 201);
    assert.deepEqual(Object.keys(created.json).sort(), ["key", "secret"]);
    assert.match(created.json.secret, /^wh_[A-Za-z0-9_-]+$/);
    assert.equal(created.json.key.name, "CI bot");
    assert.equal(created.json.key.prefix, created.json.secret.slice(0, 10));
    assert.equal(created.json.key.canWriteDocs, false);

    const page = await app("GET", "/api/app/agents", p.sess);
    assert.equal(page.status, 200);
    assert.equal(page.json.keys.length, 1);
    assert.ok(!page.text.includes(created.json.secret), "the value never comes back");
    assert.ok(!page.text.includes(created.json.secret.slice(0, 20)), "not even most of it");
    assert.ok(!/keyHash|key_hash/.test(page.text));
    assert.match(page.json.setup.mcp, /\/mcp /);
  });

  test("the key works on the frozen API for its own team, and stops when it is revoked", async () => {
    const p = await signUp();
    const { json } = await app("POST", "/api/app/keys", p.sess, { body: { name: "agent" } });
    const before = await v1({ key: json.secret }, "list_projects");
    assert.equal(before.status, 200);
    assert.deepEqual(before.json.data, [], "the new team has no projects, and sees none of team A's");
    assert.deepEqual((await app("DELETE", `/api/app/keys/${json.key.id}`, p.sess)).json, { ok: true });
    assert.equal((await v1({ key: json.secret }, "list_projects")).status, 401);
    const listed = (await app("GET", "/api/app/agents", p.sess)).json.keys[0];
    assert.ok(listed.revokedAt);
  });

  test("a blank name gets a default; the Agents page's commands carry the project key when there is exactly one project", async () => {
    const p = await signUp();
    assert.equal((await app("POST", "/api/app/keys", p.sess, { body: { name: "  " } })).json.key.name, "Claude agent");
    assert.equal((await app("GET", "/api/app/agents", p.sess)).json.setup.projectKey, "KEY");
    await app("POST", "/api/app/projects", p.sess, { body: { name: "Rocket", key: "RKT" } });
    const setup = (await app("GET", "/api/app/agents", p.sess)).json.setup;
    assert.equal(setup.projectKey, "RKT");
    assert.ok(setup.linkRepo.includes("RKT"));
    assert.ok(!/wh_[A-Za-z0-9_-]{10}/.test(JSON.stringify(setup)), "no key in any command");
  });

  test("docs:write is off by default and can be granted and taken away", async () => {
    const p = await signUp();
    const k = (await app("POST", "/api/app/keys", p.sess, { body: { name: "writer" } })).json.key;
    const on = await app("PATCH", `/api/app/keys/${k.id}`, p.sess, { body: { docsWrite: true } });
    assert.equal(on.json.key.canWriteDocs, true);
    assert.equal((await app("GET", "/api/app/agents", p.sess)).json.keys[0].canWriteDocs, true);
    assert.equal((await app("PATCH", `/api/app/keys/${k.id}`, p.sess, { body: { docsWrite: false } })).json.key.canWriteDocs, false);
    const bad = await app("PATCH", `/api/app/keys/${k.id}`, p.sess, { body: { docsWrite: "yes" } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, "invalid");
  });

  test("another team's key cannot be revoked, changed or reset: 404, and it keeps working", async () => {
    const mine = await signUp();
    const theirs = await signUp("Theirs");
    const k = (await app("POST", "/api/app/keys", theirs.sess, { body: { name: "theirs" } })).json;
    assert.equal((await app("DELETE", `/api/app/keys/${k.key.id}`, mine.sess)).status, 404);
    assert.equal((await app("PATCH", `/api/app/keys/${k.key.id}`, mine.sess, { body: { docsWrite: true } })).status, 404);
    assert.equal((await app("POST", "/api/app/agents/mark-all-seen", mine.sess, { body: { keyId: k.key.id } })).status, 404);
    assert.equal((await v1({ key: k.secret }, "list_projects")).status, 200);
    assert.equal((await app("GET", "/api/app/agents", theirs.sess)).json.keys[0].canWriteDocs, false);
    assert.deepEqual((await app("GET", "/api/app/agents", mine.sess)).json.keys, [], "and it is not in my list");
  });

  test("marking all seen answers ok, for one key and for everything", async () => {
    const p = await signUp();
    const k = (await app("POST", "/api/app/keys", p.sess, { body: { name: "a" } })).json.key;
    assert.deepEqual((await app("POST", "/api/app/agents/mark-all-seen", p.sess, { body: { keyId: k.id } })).json, { ok: true });
    assert.deepEqual((await app("POST", "/api/app/agents/mark-all-seen", p.sess, { body: {} })).json, { ok: true });
  });

  test("ten keys an hour per person, then 429 with a Retry-After", async () => {
    const p = await signUp();
    for (let i = 0; i < 10; i++) assert.equal((await app("POST", "/api/app/keys", p.sess, { body: { name: `k${i}` } })).status, 201);
    const r = await app("POST", "/api/app/keys", p.sess, { body: { name: "eleventh" } });
    assert.equal(r.status, 429);
    assert.equal(r.json.error.code, "rate_limited");
    assert.match(r.headers.get("retry-after") ?? "", /^\d+$/);
  });
});

describe("invites", () => {
  test("an owner gets a one-time link; the invitee follows it, chooses a password and lands signed in, in that team", async () => {
    const o = await signUp("Team lead");
    const email = newEmail();
    const inv = await app("POST", "/api/app/invites", o.sess, { body: { kind: "join_team", email: email.toUpperCase(), role: "member", tags: "Backend" } });
    assert.equal(inv.status, 201);
    assert.match(inv.json.link, /\/invite#[A-Za-z0-9_-]{43}$/);
    assert.equal(inv.json.email, email, "lower-cased");
    const token = inv.json.link.split("#")[1];

    const listed = await app("GET", "/api/app/invites", o.sess);
    assert.deepEqual(listed.json.invites.map((i: { email: string }) => i.email), [email]);
    assert.ok(!listed.text.includes(token), "the link is never shown again");

    const peek = await app("POST", "/api/app/invites/peek", anon(), { body: { token } });
    assert.deepEqual(peek.json, { invite: { email, kind: "join_team", teamName: "Team lead team" } });

    const accepted = await app("POST", "/api/app/invites/accept", anon(), { body: { token, name: "  New Person ", password: PW, confirm: PW } });
    assert.equal(accepted.status, 201);
    assert.equal(accepted.json.team.id, o.me.team.id);
    assert.equal(accepted.json.role, "member");
    assert.equal(accepted.json.user.name, "New Person");
    const s = sessionFrom(accepted);
    assert.equal((await app("GET", "/api/app/me", s)).json.user.email, email);
    assert.deepEqual((await app("GET", "/api/app/team", s)).json.members.find((m: { email: string }) => m.email === email).tags, ["backend"]);
    assert.deepEqual((await app("GET", "/api/app/invites", o.sess)).json.invites, [], "used");
    const again = await app("POST", "/api/app/invites/accept", anon(), { body: { token, name: "Again", password: PW, confirm: PW } });
    assert.equal(again.status, 400);
    assert.equal(again.json.error.message, "This invite link is invalid or has expired.");
    assert.equal(again.cookies.length, 0);
  });

  test("every bad link gets the same answer, so a link cannot be probed", async () => {
    const o = await signUp();
    const inv = (await app("POST", "/api/app/invites", o.sess, { body: { kind: "join_team", email: newEmail() } })).json;
    await app("DELETE", `/api/app/invites/${inv.id}`, o.sess);
    const answers = [];
    for (const token of ["", "short", "A".repeat(43), inv.link.split("#")[1]]) {
      const r = await app("POST", "/api/app/invites/peek", anon(), { body: { token } });
      answers.push([r.status, r.json]);
      const a = await app("POST", "/api/app/invites/accept", anon(), { body: { token, name: "X", password: PW, confirm: PW } });
      assert.equal(a.status, 400);
      assert.equal(a.json.error.message, "This invite link is invalid or has expired.", `accept: ${token.slice(0, 8)}`);
    }
    for (const a of answers) assert.deepEqual(a, answers[0]);
    assert.deepEqual(answers[0], [400, { error: { code: "invalid", message: "This invite link is invalid or has expired." } }]);
  });

  test("the two passwords must match, and a weak one is a field error", async () => {
    const o = await signUp();
    const token = (await app("POST", "/api/app/invites", o.sess, { body: { kind: "join_team", email: newEmail() } })).json.link.split("#")[1];
    const mismatch = await app("POST", "/api/app/invites/accept", anon(), { body: { token, name: "X", password: PW, confirm: PW + "!" } });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.json.error.message, "The two passwords do not match");
    assert.ok(mismatch.json.error.details.fields.confirm);
    const weak = await app("POST", "/api/app/invites/accept", anon(), { body: { token, name: "X", password: "short", confirm: "short" } });
    assert.equal(weak.status, 400);
    assert.equal(weak.json.error.message, "Password must be at least 12 characters");
    assert.equal(weak.cookies.length, 0);
    const still = await app("POST", "/api/app/invites/peek", anon(), { body: { token } });
    assert.equal(still.status, 200, "a failed attempt does not use the invite up");
  });

  test("a member cannot invite; a team owner cannot invite to a new team; there is one pending invite per email", async () => {
    const o = await signUp();
    const m = await addMember(o);
    const asMember = await app("POST", "/api/app/invites", m.sess, { body: { kind: "join_team", email: newEmail() } });
    assert.equal(asMember.status, 403);
    assert.equal(asMember.json.error.code, "forbidden");
    const newTeam = await app("POST", "/api/app/invites", o.sess, { body: { kind: "new_team", email: newEmail() } });
    assert.equal(newTeam.status, 403);
    const email = newEmail();
    assert.equal((await app("POST", "/api/app/invites", o.sess, { body: { kind: "join_team", email } })).status, 201);
    const dup = await app("POST", "/api/app/invites", o.sess, { body: { kind: "join_team", email } });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.error.code, "conflict");
    const bad = await app("POST", "/api/app/invites", o.sess, { body: { kind: "join_team", email: "not an email" } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.message, "Enter a valid email address");
  });

  test("seats are counted with pending invites; a full team says so (409), and revoking frees a seat", async () => {
    const o = await signUp();
    const max = (await app("GET", "/api/app/team", o.sess)).json.seats.max;
    const ids: string[] = [];
    for (let i = 1; i < max; i++) ids.push((await app("POST", "/api/app/invites", o.sess, { body: { kind: "join_team", email: newEmail() } })).json.id);
    const team = (await app("GET", "/api/app/team", o.sess)).json;
    assert.equal(team.seats.full, true);
    const over = await app("POST", "/api/app/invites", o.sess, { body: { kind: "join_team", email: newEmail() } });
    assert.equal(over.status, 409);
    assert.match(over.json.error.message, /^Your workspace is full/);
    assert.deepEqual((await app("DELETE", `/api/app/invites/${ids[0]}`, o.sess)).json, { ok: true });
    assert.equal((await app("POST", "/api/app/invites", o.sess, { body: { kind: "join_team", email: newEmail() } })).status, 201);
  });

  test("another team's invites are invisible and cannot be revoked", async () => {
    const mine = await signUp();
    const theirs = await signUp("Theirs");
    const inv = (await app("POST", "/api/app/invites", theirs.sess, { body: { kind: "join_team", email: newEmail() } })).json;
    assert.deepEqual((await app("GET", "/api/app/invites", mine.sess)).json.invites, []);
    const r = await app("DELETE", `/api/app/invites/${inv.id}`, mine.sess);
    assert.equal(r.status, 404);
    assert.equal((await app("GET", "/api/app/invites", theirs.sess)).json.invites.length, 1, "still there");
  });

  test("new-team invites: only an instance admin lists or makes them; the invitee gets a team of their own", async () => {
    const admin = await signIn(fx.admin.email);
    const ordinary = await signUp();
    assert.equal((await app("GET", "/api/app/invites?kind=new_team", ordinary.sess)).status, 404, "the page does not exist for them");
    const email = newEmail();
    const inv = await app("POST", "/api/app/invites", admin, { body: { kind: "new_team", email, team: "Fresh Co" } });
    assert.equal(inv.status, 201);
    const listed = await app("GET", "/api/app/invites?kind=new_team", admin);
    assert.ok(listed.json.invites.some((i: { email: string; teamName: string }) => i.email === email && i.teamName === "Fresh Co"));
    const token = inv.json.link.split("#")[1];
    assert.deepEqual((await app("POST", "/api/app/invites/peek", anon(), { body: { token } })).json.invite, { email, kind: "new_team", teamName: "Fresh Co" });
    const accepted = await app("POST", "/api/app/invites/accept", anon(), { body: { token, name: "Founder", password: PW, confirm: PW } });
    assert.equal(accepted.json.role, "owner");
    assert.equal(accepted.json.team.name, "Fresh Co");
    assert.notEqual(accepted.json.team.id, fx.admin.teamId);
    assert.deepEqual((await app("DELETE", `/api/app/invites/${(await app("POST", "/api/app/invites", admin, { body: { kind: "new_team", email: newEmail() } })).json.id}`, admin)).json, { ok: true });
  });

  test("twenty invites an hour per person, then 429", async () => {
    const o = await signUp();
    const statuses = new Set<number>();
    let limited;
    for (let i = 0; i < 22 && !limited; i++) {
      const r = await app("POST", "/api/app/invites", o.sess, { body: { kind: "join_team", email: newEmail() } });
      statuses.add(r.status);
      if (r.status === 429) limited = r;
    }
    assert.ok(limited || statuses.has(409), "either the hourly limit or the seat limit stops it");
    // The seat limit comes first on a default server, so the hourly limit is shown with a person who keeps revoking.
    const p = await signUp();
    let hit: Awaited<ReturnType<typeof app>> | undefined;
    for (let i = 0; i < 25 && !hit; i++) {
      const made = await app("POST", "/api/app/invites", p.sess, { body: { kind: "join_team", email: newEmail() } });
      if (made.status === 201) await app("DELETE", `/api/app/invites/${made.json.id}`, p.sess);
      else if (made.status === 429) hit = made;
    }
    assert.ok(hit, "the 21st creation is refused");
    assert.equal(hit!.json.error.code, "rate_limited");
    assert.match(hit!.headers.get("retry-after") ?? "", /^\d+$/);
  });

  test("peeking is limited per address: 30 tries in 15 minutes, then 429", async () => {
    const ip = freshIp();
    let last;
    for (let i = 0; i < 31; i++) last = await app("POST", "/api/app/invites/peek", anon(), { ip, body: { token: "nope" } });
    assert.equal(last!.status, 429);
    assert.equal(last!.json.error.code, "rate_limited");
    const elsewhere = await app("POST", "/api/app/invites/peek", anon(), { body: { token: "nope" } });
    assert.equal(elsewhere.status, 400, "another address is not affected");
  });
});

describe("the instance admin's teams pages", () => {
  test("to anyone else they do not exist (404); the actions are forbidden (403)", async () => {
    const owner = await signIn(fx.a.email);
    for (const path of ["/api/app/admin/teams", `/api/app/admin/teams/${fx.a.teamId}`]) {
      const r = await app("GET", path, owner);
      assert.equal(r.status, 404, path);
      assert.equal(r.json.error.code, "not_found");
    }
    const suspend = await app("POST", `/api/app/admin/teams/${fx.b.teamId}/suspend`, owner, { body: { confirm: "Contract team B" } });
    assert.ok([403, 404].includes(suspend.status), String(suspend.status));
    const restore = await app("POST", `/api/app/admin/teams/${fx.b.teamId}/restore`, owner, { body: {} });
    assert.ok([403, 404].includes(restore.status));
    assert.equal((await app("GET", "/api/app/me", await signIn(fx.b.email))).status, 200, "team B is untouched");
  });

  test("an admin sees every team with counts and emails only, and a team's detail without anything it wrote", async () => {
    const admin = await signIn(fx.admin.email);
    const list = await app("GET", "/api/app/admin/teams", admin);
    assert.equal(list.status, 200);
    const names = list.json.teams.map((t: { name: string }) => t.name);
    for (const n of ["Contract team A", "Contract team B", "Contract admin team", "Contract suspended team"]) assert.ok(names.includes(n), n);
    const a = list.json.teams.find((t: { id: string }) => t.id === fx.a.teamId);
    assert.equal(a.isYours, false);
    assert.equal(a.members, 2);
    assert.equal(a.projects, 1);
    assert.ok(list.json.teams.find((t: { id: string }) => t.id === fx.admin.teamId).isYours);
    assert.ok(list.json.teams.find((t: { name: string }) => t.name === "Contract suspended team").suspendedAt);

    const detail = await app("GET", `/api/app/admin/teams/${fx.a.teamId}`, admin);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.team.memberList.length, 2);
    assert.ok(detail.json.team.keys.length >= 3);
    assert.ok(!detail.text.includes(fx.a.apiKey), "no key value");
    assert.ok(!detail.text.includes("Contract ticket A"), "nothing the team wrote");
    assert.ok(!/passwordHash|keyHash/.test(detail.text));
    assert.equal((await app("GET", `/api/app/admin/teams/00000000-0000-4000-8000-000000000000`, admin)).status, 404);
  });

  test("suspending needs the exact name, refuses your own team, signs members out and blocks sign-in; restoring undoes it", async () => {
    const admin = await signIn(fx.admin.email);
    const victim = await signUp("Victim");
    const k = (await app("POST", "/api/app/keys", victim.sess, { body: { name: "k" } })).json.secret;
    const id = victim.me.team.id;

    const own = await app("POST", `/api/app/admin/teams/${fx.admin.teamId}/suspend`, admin, { body: { confirm: "Contract admin team" } });
    assert.equal(own.status, 409);
    assert.equal(own.json.error.message, "You cannot suspend your own workspace");
    const wrong = await app("POST", `/api/app/admin/teams/${id}/suspend`, admin, { body: { confirm: "victim team" } });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.json.error.message, "Type the workspace name exactly to confirm");
    assert.equal((await app("GET", "/api/app/me", victim.sess)).status, 200, "still signed in");

    const done = await app("POST", `/api/app/admin/teams/${id}/suspend`, admin, { body: { confirm: "Victim team", reason: "contract test" } });
    assert.equal(done.status, 200);
    assert.deepEqual(done.json, { name: "Victim team", sessionsEnded: 1 });
    assert.equal((await app("GET", "/api/app/me", victim.sess)).status, 401, "members are signed out");
    const blocked = await login(victim.email, PW);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.error.code, "team_suspended");
    assert.equal((await v1({ key: k }, "list_projects")).status, 403, "its keys are refused");
    const again = await app("POST", `/api/app/admin/teams/${id}/suspend`, admin, { body: { confirm: "Victim team" } });
    assert.equal(again.status, 409);
    const detail = (await app("GET", `/api/app/admin/teams/${id}`, admin)).json.team;
    assert.ok(detail.suspendedAt);
    assert.equal(detail.suspendedReason, "contract test");
    assert.equal(detail.suspendedBy.email, fx.admin.email);

    assert.deepEqual((await app("POST", `/api/app/admin/teams/${id}/restore`, admin, { body: {} })).json, { ok: true });
    assert.equal((await login(victim.email, PW)).status, 200, "people sign in again");
    assert.equal((await v1({ key: k }, "list_projects")).status, 200);
    assert.equal((await app("POST", `/api/app/admin/teams/${id}/restore`, admin, { body: {} })).status, 409, "it is not suspended any more");
  });
});

describe("POST /api/app/projects", () => {
  test("creates a project with the five columns, derives a key from the name, and answers 201", async () => {
    const p = await signUp();
    const r = await app("POST", "/api/app/projects", p.sess, { body: { name: "Rocket Launcher", description: "Agents read this." } });
    assert.equal(r.status, 201);
    assert.deepEqual(Object.keys(r.json.project).sort(), ["createdAt", "description", "id", "key", "name"]);
    assert.equal(r.json.project.name, "Rocket Launcher");
    assert.equal(r.json.project.key, "ROC");
    assert.equal(r.json.project.description, "Agents read this.");
    assert.deepEqual((await app("GET", "/api/app/projects", p.sess)).json.projects.map((x: { key: string }) => x.key), ["ROC"]);
  });

  test("a chosen key is upper-cased and cut to six; a taken key is a 409; a blank name is a 400", async () => {
    const p = await signUp();
    assert.equal((await app("POST", "/api/app/projects", p.sess, { body: { name: "One", key: "abcdefgh" } })).json.project.key, "ABCDEF");
    const dup = await app("POST", "/api/app/projects", p.sess, { body: { name: "Two", key: "ABCDEF" } });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.error.message, "Project key ABCDEF already in use");
    const blank = await app("POST", "/api/app/projects", p.sess, { body: { name: "  " } });
    assert.equal(blank.status, 400);
    assert.equal(blank.json.error.message, "Project name is required");
  });

  test("keys are per team: another team can use a key that is taken elsewhere, and neither sees the other's project", async () => {
    const x = await signUp();
    const y = await signUp("Other");
    assert.equal((await app("POST", "/api/app/projects", x.sess, { body: { name: "Shared", key: "SHR" } })).status, 201);
    assert.equal((await app("POST", "/api/app/projects", y.sess, { body: { name: "Shared too", key: "SHR" } })).status, 201);
    assert.equal((await app("GET", "/api/app/projects", x.sess)).json.projects[0].name, "Shared");
  });

  test("an agent session can be removed by a teammate of that project's team only", async () => {
    const owner = await signIn(fx.a.email);
    const unknown = await app("DELETE", `/api/app/projects/${fx.a.projectKey}/sessions/nonexistent`, owner);
    assert.equal(unknown.status, 404);
    const crossTeam = await app("DELETE", `/api/app/projects/${fx.b.projectKey}/sessions/nonexistent`, owner);
    assert.equal(crossTeam.status, 404);
    assert.equal(crossTeam.json.error.code, "not_found");
  });
});

describe("the dashboard", () => {
  const WIDGETS = ["kpis", "progress", "throughput", "activity-split", "agents", "attention", "recent", "sync"];

  test("every widget answers for the signed-in person's team, with the shape the page draws", async () => {
    const s = await signIn(fx.a.email);
    const get = async (w: string) => {
      const r = await app("GET", `/api/app/dashboard/${w}`, s);
      assert.equal(r.status, 200, w);
      return r.json;
    };
    const kpis = await get("kpis");
    assert.deepEqual(Object.keys(kpis).sort(), ["agentShare7d", "agents", "agentsActive7d", "completed7d", "completedPrev7d", "events7d", "inProgress", "inReview", "mapNodes", "open", "projects", "staleDocs", "staleNodes"]);
    assert.equal(kpis.projects, 1);
    const progress = await get("progress");
    assert.deepEqual(progress.map((p: { key: string }) => p.key), [fx.a.projectKey], "team A's project, never team B's");
    assert.deepEqual(Object.keys(progress[0]).sort(), ["agentReady", "done", "id", "key", "lastActivity", "mapNodes", "name", "pct", "stages", "staleDocs", "staleNodes", "total", "urgent"]);
    assert.equal(progress[0].stages.length, 5);
    for (const w of ["throughput", "activity-split"]) {
      const days = await get(w);
      assert.equal(days.length, 14, w);
      assert.match(days[0].day, /^\d{4}-\d{2}-\d{2}$/);
    }
    assert.ok(Array.isArray(await get("agents")));
    assert.deepEqual(Object.keys(await get("attention")).sort(), ["review", "stale", "staleDocs", "urgent"]);
    assert.deepEqual(Object.keys(await get("sync")).sort(), ["drafts", "quiet", "untracked"]);
    const recent = await get("recent");
    assert.ok(recent.length > 0);
    assert.deepEqual(Object.keys(recent[0]).sort(), ["actorKind", "actorName", "createdAt", "projectKey", "seq", "summary"], "only what a row shows: no ids or internals");
    assert.ok(recent.every((e: { projectKey: string }) => e.projectKey === fx.a.projectKey));
  });

  test("team B sees its own numbers, and a new team starts empty", async () => {
    const b = await app("GET", "/api/app/dashboard/progress", await signIn(fx.b.email));
    assert.deepEqual(b.json.map((p: { key: string }) => p.key), [fx.b.projectKey]);
    const fresh = await signUp();
    assert.deepEqual((await app("GET", "/api/app/dashboard/progress", fresh.sess)).json, []);
    assert.deepEqual((await app("GET", "/api/app/dashboard/recent", fresh.sess)).json, []);
    assert.equal((await app("GET", "/api/app/dashboard/kpis", fresh.sess)).json.open, 0);
  });

  test("a widget that does not exist is a 404, not an error", async () => {
    const s = await signIn(fx.a.email);
    for (const w of ["nope", "constructor", "__proto__", "toString"]) {
      const r = await app("GET", `/api/app/dashboard/${w}`, s);
      assert.equal(r.status, 404, w);
      assert.equal(r.json.error.code, "not_found");
    }
    assert.equal(WIDGETS.length, 8);
  });

  test("a teamId in the query or a header changes nothing", async () => {
    const s = await signIn(fx.a.email);
    const r = await app("GET", `/api/app/dashboard/progress?teamId=${fx.b.teamId}`, s, { headers: { "x-team-id": fx.b.teamId } });
    assert.deepEqual(r.json.map((p: { key: string }) => p.key), [fx.a.projectKey]);
  });
});
