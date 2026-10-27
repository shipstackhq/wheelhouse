import { describe, test, before } from "node:test";
import assert from "node:assert/strict";
import { v1ok } from "./lib/http";
import { anon, app, newEmail, newAccount, sessionFrom, type Sess } from "./lib/app";

/**
 * Projects (WH-118): the endpoints, who sees what over HTTP (a member of one team sees the other team only as totals), and what an
 * agent on /api/v1 does and does not see. Everything runs in a workspace made for the test (the seeded ones keep their recorded
 * shapes): its owner leads, its member is on one team only.
 */

type Project = {
  id: string; name: string; status: string; version: number; total: number; done: number; teamCount: number; canEdit: boolean; canAdmin?: boolean;
  health: { derived: string | null; override: string | null; value: string | null };
  leadUser: { id: string; name: string } | null; leadTeam: { key: string; name: string } | null;
  milestones: { id: string; name: string; total: number; done: number }[];
  teams: { key: string; lead: boolean; total: number; done: number; issues: { ref: string; title: string }[] }[];
  others: { count: number; total: number; done: number };
  addableTeams: { key: string }[];
};

const PW = "a-long-enough-password";
let owner: Sess;
let member: Sess;
let teamA: string; // the owner and the member are on it (the lead team of most projects)
let second: string; // only the owner is on it
let apiKey: string;
let apiKey2: string;
let n = 0;
let k = 0;
const newKey = () => `P${Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 3).toUpperCase()}${String.fromCharCode(65 + (k++ % 26))}`;

before(async () => {
  const o = await newAccount("Owner");
  owner = o.sess;
  const email = newEmail();
  const inv = await app("POST", "/api/app/invites", owner, { body: { kind: "join_workspace", email, role: "member" } });
  assert.equal(inv.status, 201, inv.text);
  const joined = await app("POST", "/api/app/invites/accept", anon(), { body: { token: inv.json.link.split("#")[1], name: "Member", password: PW, confirm: PW } });
  assert.equal(joined.status, 201, joined.text);
  member = sessionFrom(joined);
  teamA = newKey();
  second = newKey();
  for (const key of [teamA, second]) assert.equal((await app("POST", "/api/app/teams", owner, { body: { name: `Team ${key}`, key } })).status, 201);
  assert.equal((await app("POST", `/api/app/teams/${teamA}/members`, owner, { body: { userId: joined.json.user.id, role: "editor" } })).status, 201);
  apiKey = (await app("POST", "/api/app/keys", owner, { body: { name: "agent" } })).json.secret as string;
  apiKey2 = (await app("POST", "/api/app/keys", owner, { body: { name: "agent two" } })).json.secret as string;
});

const make = async (body: Record<string, unknown> = {}, s: Sess = owner) => {
  const r = await app("POST", "/api/app/projects", s, { body: { name: `Project ${++n} ${Date.now()}`, leadTeam: teamA, ...body } });
  assert.equal(r.status, 201, r.text);
  return r.json.project as Project;
};
const issue = async (team: string, body: Record<string, unknown>, s: Sess = owner) => {
  const r = await app("POST", `/api/app/teams/${team}/issues`, s, { body: { title: `t ${++n}`, ...body } });
  assert.equal(r.status, 201, r.text);
  return r.json.issue as { ref: string; projectId: string | null; milestoneId: string | null };
};

describe("the projects endpoints", () => {
  test("signed out is a 401, and a forged request is refused", async () => {
    assert.equal((await app("GET", "/api/app/projects", anon())).status, 401);
    assert.equal((await app("POST", "/api/app/projects", owner, { body: {}, origin: "https://evil.example" })).status, 403);
    assert.equal((await app("POST", "/api/app/projects", owner, { body: {}, csrf: null })).status, 403);
  });

  test("a project is made with a lead team and other teams; the answer is the whole project", async () => {
    const p = await make({ description: "Words", status: "active", startDate: "2026-11-01", targetDate: "2026-12-31", teams: [second] });
    assert.deepEqual([p.status, p.version, p.teamCount, p.canEdit], ["active", 1, 2, true]);
    assert.deepEqual(p.teams.map((t) => [t.key, t.lead]), [[teamA, true], [second, false]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    assert.equal(p.leadTeam!.key, teamA);
    const list = (await app("GET", "/api/app/projects", owner)).json.projects as Project[];
    assert.ok(list.some((x) => x.id === p.id));
    assert.equal(list.find((x) => x.id === p.id)!.name, p.name);
  });

  test("a bad request is a 400 naming the field", async () => {
    for (const [body, field] of [
      [{ name: "" }, "name"],
      [{ leadTeam: undefined }, "leadTeam"],
      [{ status: "someday" }, "status"],
      [{ startDate: "2026-12-31", targetDate: "2026-01-01" }, "targetDate"],
      [{ startDate: "31/12/2026" }, "startDate"],
      [{ healthOverride: "great" }, "healthOverride"],
      [{ teams: "all" }, "teams"],
    ] as const) {
      const r = await app("POST", "/api/app/projects", owner, { body: { ...{ name: "x", leadTeam: teamA }, ...body } });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.ok(r.json.error.details.fields[field], `${JSON.stringify(body)} names ${field}`);
    }
    assert.equal((await app("POST", "/api/app/projects", owner, { body: { name: "x", leadTeam: "NOPE" } })).status, 404, "a team that is not there");
  });

  test("one project, changed with the version: a stale version is a 409, the same values are no change, health can be set and cleared", async () => {
    const p = await make({ status: "active" });
    const a = await app("PATCH", `/api/app/projects/${p.id}`, owner, { body: { name: "Renamed", healthOverride: "at_risk", version: p.version } });
    assert.equal(a.status, 200, a.text);
    assert.deepEqual([a.json.project.name, a.json.project.version, a.json.project.health.value], ["Renamed", p.version + 1, "at_risk"]);
    const stale = await app("PATCH", `/api/app/projects/${p.id}`, owner, { body: { name: "Late", version: p.version } });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, "conflict");
    const same = await app("PATCH", `/api/app/projects/${p.id}`, owner, { body: { name: "Renamed" } });
    assert.equal(same.json.project.version, a.json.project.version);
    const cleared = await app("PATCH", `/api/app/projects/${p.id}`, owner, { body: { healthOverride: null } });
    assert.equal(cleared.json.project.health.override, null);
    assert.equal((await app("GET", "/api/app/projects/not-an-id", owner)).status, 404);
  });

  test("an issue joins a project and milestone from the issue's own endpoint, and the board names them", async () => {
    const p = await make();
    const m = await app("POST", `/api/app/projects/${p.id}/milestones`, owner, { body: { name: "First step", targetDate: "2026-12-01" } });
    assert.equal(m.status, 201, m.text);
    const milestone = m.json.project.milestones[0];
    const t = await issue(teamA, { projectId: p.id, milestoneId: milestone.id });
    assert.deepEqual([t.projectId, t.milestoneId], [p.id, milestone.id]);
    const board = (await app("GET", `/api/app/teams/${teamA}/board`, owner)).json;
    const opt = board.projects.find((x: { id: string }) => x.id === p.id);
    assert.deepEqual([opt.name, opt.milestones.map((x: { name: string }) => x.name)], [p.name, ["First step"]]);
    assert.ok(board.issues.some((x: { ref: string; projectId: string }) => x.ref === t.ref && x.projectId === p.id));
    const out = await app("PATCH", `/api/app/issues/${t.ref}`, owner, { body: { projectId: null } });
    assert.deepEqual([out.json.issue.projectId, out.json.issue.milestoneId], [null, null]);
    const bad = await app("PATCH", `/api/app/issues/${t.ref}`, owner, { body: { milestoneId: milestone.id } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error.details.fields.milestoneId, /needs a project/);
    assert.equal((await app("PATCH", `/api/app/issues/${t.ref}`, owner, { body: { projectId: 5 } })).status, 400);
  });

  test("a team that does not take part cannot put an issue in the project; the answer says why", async () => {
    const p = await make(); // the seeded team only
    const r = await app("POST", `/api/app/teams/${second}/issues`, owner, { body: { title: "wrong team", projectId: p.id } });
    assert.equal(r.status, 400);
    assert.match(r.json.error.details.fields.projectId, /does not take part/);
  });

  test("teams: bring one in, refuse a second time, take it out (with its issues, only when asked), never the lead team", async () => {
    const p = await make();
    const added = await app("POST", `/api/app/projects/${p.id}/teams`, owner, { body: { team: second } });
    assert.equal(added.status, 201, added.text);
    assert.equal(added.json.project.teamCount, 2);
    assert.equal((await app("POST", `/api/app/projects/${p.id}/teams`, owner, { body: { team: second } })).status, 409);
    await issue(second, { projectId: p.id });
    const refused = await app("DELETE", `/api/app/projects/${p.id}/teams/${second}`, owner);
    assert.equal(refused.status, 409);
    assert.match(refused.json.error.message, /has 1 issue/);
    const gone = await app("DELETE", `/api/app/projects/${p.id}/teams/${second}?releaseIssues=1`, owner);
    assert.equal(gone.status, 200, gone.text);
    assert.deepEqual([gone.json.ok, gone.json.released], [true, 1]);
    const lead = await app("DELETE", `/api/app/projects/${p.id}/teams/${teamA}`, owner);
    assert.equal(lead.status, 409);
    assert.match(lead.json.error.message, /lead team/);
  });

  test("milestones: add, rename, move, delete; another project's milestone is a 404", async () => {
    const p = await make();
    const q = await make();
    for (const name of ["One", "Two", "Three"]) assert.equal((await app("POST", `/api/app/projects/${p.id}/milestones`, owner, { body: { name } })).status, 201);
    let v = (await app("GET", `/api/app/projects/${p.id}`, owner)).json.project as Project;
    assert.deepEqual(v.milestones.map((m) => m.name), ["One", "Two", "Three"]);
    const moved = await app("PATCH", `/api/app/projects/${p.id}/milestones/${v.milestones[2].id}`, owner, { body: { index: 0, name: "Zero" } });
    assert.deepEqual((moved.json.project as Project).milestones.map((m) => m.name), ["Zero", "One", "Two"]);
    const other = (await app("POST", `/api/app/projects/${q.id}/milestones`, owner, { body: { name: "Q" } })).json.project.milestones[0];
    assert.equal((await app("PATCH", `/api/app/projects/${p.id}/milestones/${other.id}`, owner, { body: { name: "x" } })).status, 404);
    assert.equal((await app("DELETE", `/api/app/projects/${p.id}/milestones/${other.id}`, owner)).status, 404);
    const del = await app("DELETE", `/api/app/projects/${p.id}/milestones/${v.milestones[0].id}`, owner);
    assert.equal(del.status, 200, del.text);
    v = del.json.project as Project;
    assert.equal(v.milestones.length, 2);
    assert.equal((await app("POST", `/api/app/projects/${p.id}/milestones`, owner, { body: { name: " " } })).status, 400);
  });

  test("deleting a project hides it and frees its issues; a second delete is a 404", async () => {
    const p = await make();
    const t = await issue(teamA, { projectId: p.id });
    const d = await app("DELETE", `/api/app/projects/${p.id}`, owner);
    assert.equal(d.status, 200, d.text);
    assert.deepEqual([d.json.ok, d.json.released], [true, 1]);
    assert.equal((await app("GET", `/api/app/projects/${p.id}`, owner)).status, 404);
    assert.equal((await app("GET", `/api/app/issues/${t.ref}`, owner)).json.issue.projectId, null);
    assert.equal((await app("DELETE", `/api/app/projects/${p.id}`, owner)).status, 404);
  });
});

describe("who sees what over HTTP", () => {
  test("the member of one team sees the other team only as totals: no key, no name, no title", async () => {
    const p = await make({ teams: [second] });
    await issue(teamA, { title: "OWN-VISIBLE", projectId: p.id, status: "Done" });
    await issue(second, { title: "SECOND-SECRET one", projectId: p.id, status: "Done" });
    await issue(second, { title: "SECOND-SECRET two", projectId: p.id });
    const r = await app("GET", `/api/app/projects/${p.id}`, member);
    assert.equal(r.status, 200, r.text);
    const seen = r.json.project as Project;
    assert.deepEqual(seen.teams.map((t) => t.key), [teamA]);
    assert.deepEqual(seen.teams[0].issues.map((t) => t.title), ["OWN-VISIBLE"]);
    assert.deepEqual(seen.others, { count: 1, total: 2, done: 1 });
    assert.deepEqual([seen.total, seen.done], [3, 2]);
    for (const leak of ["SECOND-SECRET", second, "Second team"]) assert.ok(!r.text.includes(leak), `the member's answer must not contain ${leak}`);
    const list = await app("GET", "/api/app/projects", member);
    for (const leak of ["SECOND-SECRET", second, "Second team"]) assert.ok(!list.text.includes(leak), `nor the list: ${leak}`);
  });

  test("a project of a team the person is not on is a 404, and a member cannot change what the lead team's editors would not", async () => {
    const own = await make({ leadTeam: second }); // led by the second team: the member is not on it
    assert.equal((await app("GET", `/api/app/projects/${own.id}`, member)).status, 404);
    assert.ok(!((await app("GET", "/api/app/projects", member)).json.projects as Project[]).some((x) => x.id === own.id));
    assert.equal((await app("PATCH", `/api/app/projects/${own.id}`, member, { body: { name: "mine" } })).status, 404);
    const shared = await make({ teams: [second] }); // led by the seeded team, which the member edits
    assert.equal((await app("PATCH", `/api/app/projects/${shared.id}`, member, { body: { description: "by the member" } })).status, 200);
    assert.equal((await app("DELETE", `/api/app/projects/${shared.id}`, member)).status, 403, "deleting needs an admin of the lead team");
  });

  test("another workspace sees nothing, and can use nothing", async () => {
    const mine = await make();
    const other = await newAccount("Elsewhere");
    assert.deepEqual((await app("GET", "/api/app/projects", other.sess)).json.projects, []);
    for (const [method, path, body] of [
      ["GET", `/api/app/projects/${mine.id}`, undefined],
      ["PATCH", `/api/app/projects/${mine.id}`, { name: "x" }],
      ["DELETE", `/api/app/projects/${mine.id}`, undefined],
      ["POST", `/api/app/projects/${mine.id}/teams`, { team: "AA" }],
      ["POST", `/api/app/projects/${mine.id}/milestones`, { name: "x" }],
    ] as const) assert.equal((await app(method, path, other.sess, body ? { body } : {})).status, 404, `${method} ${path}`);
    assert.equal((await app("POST", "/api/app/projects", other.sess, { body: { name: "steal", leadTeam: teamA } })).status, 404);
  });
});

describe("the agent surface", () => {
  test("the tools show an issue's project by name", async () => {
    const p = await make();
    const t = await issue(teamA, { title: "For the agent", projectId: p.id });
    const board = await v1ok({ key: apiKey }, "list_issues", { team: teamA });
    assert.equal(board.team.key, teamA);
    const card = board.statuses.flatMap((c: { issues: Record<string, unknown>[] }) => c.issues).find((x: { ref: string }) => x.ref === t.ref) as Record<string, unknown>;
    assert.ok(card, "the issue is on the agent's board");
    assert.equal(card.project, p.name);
    const got = await v1ok({ key: apiKey }, "get_issue", { ref: t.ref });
    assert.equal(got.issue.project, p.name);
  });

  test("a team's agents hear an issue join a project and a milestone change", async () => {
    const p = await make();
    const before = (await v1ok({ key: apiKey }, "get_changes", { team: teamA })).changes.length;
    void before;
    const t = await issue(teamA, { projectId: p.id });
    await app("POST", `/api/app/projects/${p.id}/milestones`, owner, { body: { name: "Heard" } });
    const changes = (await v1ok({ key: apiKey2 }, "get_changes", { team: teamA })).changes as { type: string; summary: string }[];
    const mine = changes.filter((c) => c.summary.includes(p.name) || c.summary.includes(t.ref)).map((c) => c.type);
    assert.ok(mine.includes("project.issue_joined"), mine.join(", "));
    assert.ok(mine.includes("project.milestone_changed"), mine.join(", "));
  });
});
