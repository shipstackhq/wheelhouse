/**
 * Projects (WH-118) against a real database: the keys that keep an issue inside a team that takes part, who sees what (plan
 * section 5, including the totals-only view of teams you are not on), health and progress on a fixed clock, teams and milestones.
 * Runs on an in-memory PGlite (`pnpm test`), or a real Postgres with TEST_DATABASE_URL.
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  process.env.PGLITE_DIR = "memory://";
  delete process.env.DATABASE_URL;
}

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "../../../db";
import type { TeamRole, WorkspaceRole } from "../../../db/schema";
import type { Actor } from "../../../common/actor";
import { ServiceError } from "../../../common/service-error";
import { createTeam, deleteTeam } from "../../teams/teams.legacy";
import { IssueInput, createIssue, getIssue, updateIssue } from "../issues.legacy";
import * as pr from "../issues.legacy";
import { addTeamMember, setTeamMemberRole } from "../../teams/teams.legacy";
import { testApp } from "../../../test/app";
await testApp();

const RUN = Math.random().toString(16).slice(2, 8);
const L = RUN.replace(/[0-9]/g, (c) => "ghijklmnop"[Number(c)]).slice(0, 2).toUpperCase();
// A statement refused at once carries Postgres's code on `cause`; one refused when the transaction commits (a deferred key) carries it on the error.
const refusedWith = (code: string) => (e: unknown) => (e as { cause?: { code?: string }; code?: string }).cause?.code === code || (e as { code?: string }).code === code;
const foreign = refusedWith("23503");
const checked = refusedWith("23514");
const code = (c: ServiceError["code"]) => (e: unknown) => e instanceof ServiceError && e.code === c;
const D = (s: string) => new Date(`${s}T12:00:00.000Z`);

let db: Awaited<ReturnType<typeof getDb>>;
let wsId: string;
let ada: Actor; // owner of the workspace; admin of teams A and B
let bob: Actor; // member; editor of A only
let cy: Actor; // member; editor of B only
let dee: Actor; // member; on no team
let gus: Actor; // guest; on team A
let vic: Actor; // workspace viewer; editor of A (capped to read)
let eve: Actor; // owner of another workspace
let ta: { id: string; key: string; name: string; workspaceId: string };
let tb: typeof ta;
let tc: typeof ta; // a team nobody but ada is on
let n = 0;

async function person(workspaceId: string, role: WorkspaceRole, name: string): Promise<Actor> {
  const [u] = await db.insert(schema.users).values({ email: `${name}-${RUN}-${++n}@example.com`, name, passwordHash: "x" }).returning();
  await db.insert(schema.memberships).values({ userId: u.id, workspaceId, role });
  return { kind: "human", id: u.id, name, workspaceId };
}
const join = (team: { key: string }, who: Actor, role: TeamRole) => addTeamMember(ada, team.key, { userId: who.id, role });
const teamRow = async (key: string) => (await db.select().from(schema.teams).where(eq(schema.teams.key, key)))[0];

before(async () => {
  db = await getDb();
  const [w] = await db.insert(schema.workspaces).values({ name: `proj ${RUN}` }).returning();
  const [w2] = await db.insert(schema.workspaces).values({ name: `proj other ${RUN}` }).returning();
  wsId = w.id;
  ada = await person(w.id, "owner", "ada");
  bob = await person(w.id, "member", "bob");
  cy = await person(w.id, "member", "cy");
  dee = await person(w.id, "member", "dee");
  gus = await person(w.id, "guest", "gus");
  vic = await person(w.id, "viewer", "vic");
  eve = await person(w2.id, "owner", "eve");
  ta = { ...(await createTeam(ada, { name: "Alpha", key: `${L}A` })), name: "Alpha" };
  tb = { ...(await createTeam(ada, { name: "Beta", key: `${L}B` })), name: "Beta" };
  tc = { ...(await createTeam(ada, { name: "Gamma", key: `${L}C` })), name: "Gamma" };
  await join(ta, bob, "editor");
  await join(tb, cy, "editor");
  await join(ta, gus, "viewer");
  await join(ta, vic, "editor");
  ta = await teamRow(`${L}A`);
  tb = await teamRow(`${L}B`);
  tc = await teamRow(`${L}C`);
});

const project = (over: Record<string, unknown> = {}, as: Actor = ada) => pr.createProject(as, { name: `P ${++n}`, leadTeam: ta.key, ...over });
const issueIn = async (team: { key: string }, projectId: string | null, over: Partial<IssueInput> & { status?: string } = {}) => createIssue(ada, team.key, { title: `t ${++n}`, projectId, ...over });
const rawSet = (id: string, set: Partial<typeof schema.issues.$inferInsert>) => db.update(schema.issues).set(set).where(eq(schema.issues.id, id));

describe("making a project", () => {
  test("a project has a lead team that takes part, a lead user, a status and dates; the other teams are named by key", async () => {
    const p = await project({ name: "Launch SSO", description: "Ship it", status: "active", startDate: "2026-11-01", targetDate: "2026-12-15", teams: [tb.key] });
    assert.deepEqual([p.name, p.status, p.startDate, p.targetDate, p.version, p.teamCount], ["Launch SSO", "active", "2026-11-01", "2026-12-15", 1, 2]);
    assert.equal(p.leadUser!.name, "ada");
    assert.equal(p.leadTeam!.key, ta.key);
    assert.deepEqual(p.teams.map((t) => [t.key, t.lead]), [[ta.key, true], [tb.key, false]]);
  });

  test("a project has a priority, the same five levels as an issue: none until set, changed by an edit, and refused when it is not one of them", async () => {
    const plain = await project();
    assert.equal(plain.priority, "none");
    const urgent = await project({ priority: "urgent" });
    assert.equal(urgent.priority, "urgent");
    const changed = await pr.updateProject(ada, plain.id, { priority: "high", version: plain.version });
    assert.deepEqual([changed.priority, changed.version], ["high", plain.version + 1]);
    assert.equal((await pr.updateProject(ada, plain.id, { name: "renamed", version: changed.version })).priority, "high"); // an edit that does not name it leaves it
    await assert.rejects(project({ priority: "critical" }), code("invalid"));
    await assert.rejects(pr.updateProject(ada, plain.id, { priority: "whenever" }), code("invalid"));
  });

  test("it is refused without a lead team, with a team you cannot edit, a bad date, a bad status or a guest as lead", async () => {
    await assert.rejects(pr.createProject(ada, { name: "No team" }), code("invalid"));
    await assert.rejects(pr.createProject(bob, { name: "Not mine", leadTeam: tb.key }), code("not_found")); // bob is not on B: it is not there for him
    await assert.rejects(pr.createProject(ada, { name: "", leadTeam: ta.key }), code("invalid"));
    await assert.rejects(pr.createProject(ada, { name: "x", leadTeam: ta.key, startDate: "2026-12-01", targetDate: "2026-11-01" }), code("invalid"));
    await assert.rejects(pr.createProject(ada, { name: "x", leadTeam: ta.key, startDate: "2026-02-30" }), code("invalid"));
    await assert.rejects(pr.createProject(ada, { name: "x", leadTeam: ta.key, status: "someday" }), code("invalid"));
    await assert.rejects(pr.createProject(ada, { name: "x", leadTeam: ta.key, leadUser: gus.id }), code("invalid"));
    await assert.rejects(pr.createProject(ada, { name: "x", leadTeam: ta.key, leadUser: eve.id }), code("invalid"));
    await assert.rejects(pr.createProject(gus, { name: "guest's", leadTeam: ta.key }), (e: unknown) => e instanceof ServiceError);
    await assert.rejects(pr.createProject(vic, { name: "viewer's", leadTeam: ta.key }), code("forbidden"));
  });

  test("a project is announced to the workspace and to each team that takes part, nowhere else", async () => {
    const p = await project({ name: "Heard", teams: [tb.key] });
    const ws = await db.select().from(schema.workspaceEvents).where(eq(schema.workspaceEvents.entityId, p.id));
    assert.deepEqual(ws.map((e) => [e.type, e.entity]), [["project.created", "project"]]);
    const inTeam = async (team: { id: string }) => (await db.select().from(schema.events).where(and(eq(schema.events.teamId, team.id), eq(schema.events.entityId, p.id)))).map((e) => e.type);
    assert.deepEqual(await inTeam(ta), ["project.created"]);
    assert.deepEqual(await inTeam(tb), ["project.created"]);
    assert.deepEqual(await inTeam(tc), []);
  });
});

describe("what the database refuses", () => {
  test("an issue reaches a project only through a team that takes part", async () => {
    const p = await project(); // team A only
    const inB = await issueIn(tb, null);
    await assert.rejects(rawSet(inB.id, { projectId: p.id }), foreign);
    await assert.rejects(issueIn(tb, p.id), (e: unknown) => e instanceof ServiceError && e.code === "invalid" && /does not take part/.test(e.message));
    await assert.rejects(updateIssue(ada, inB.ref, { projectId: p.id }), (e: unknown) => /does not take part/.test((e as Error).message));
    assert.equal((await getIssue(ada, inB.ref)).issue.projectId, null);
    const inA = await issueIn(ta, p.id);
    assert.equal(inA.projectId, p.id);
  });

  test("a milestone belongs to the issue's project, and a milestone needs a project", async () => {
    const p1 = await project();
    const p2 = await project();
    const m1 = (await pr.createMilestone(ada, p1.id, { name: "Beta" })).milestones[0];
    const t = await issueIn(ta, p1.id);
    await assert.rejects(rawSet(t.id, { milestoneId: (await pr.createMilestone(ada, p2.id, { name: "Other" })).milestones[0].id }), foreign);
    await assert.rejects(updateIssue(ada, t.ref, { milestoneId: (await pr.getProject(ada, p2.id)).milestones[0].id }), (e: unknown) => /not in this issue's project/.test((e as Error).message));
    const free = await issueIn(ta, null);
    await assert.rejects(rawSet(free.id, { milestoneId: m1.id }), checked);
    await assert.rejects(updateIssue(ada, free.ref, { milestoneId: m1.id }), (e: unknown) => /needs a project/.test((e as Error).message));
    assert.equal((await updateIssue(ada, t.ref, { milestoneId: m1.id })).milestoneId, m1.id);
  });

  test("a project must have its lead team among its teams, checked when the transaction ends", async () => {
    const insertProject = (leadTeamId: string, extraTeams: string[]) =>
      db.transaction(async (tx) => {
        const [p] = await tx.insert(schema.projects).values({ workspaceId: wsId, name: `raw ${++n}`, leadTeamId }).returning();
        if (extraTeams.length) await tx.insert(schema.projectTeams).values(extraTeams.map((teamId) => ({ projectId: p.id, teamId, workspaceId: wsId })));
        return p;
      });
    await assert.rejects(insertProject(ta.id, [tb.id]), foreign); // the lead is not one of the teams
    await assert.rejects(insertProject(ta.id, []), foreign); // no teams at all
    const ok = await insertProject(ta.id, [ta.id, tb.id]); // the order inside the transaction does not matter
    assert.equal(ok.leadTeamId, ta.id);
    const p = await project({ teams: [tb.key] });
    await assert.rejects(db.update(schema.projects).set({ leadTeamId: tc.id }).where(eq(schema.projects.id, p.id)), foreign);
    await assert.rejects(db.delete(schema.projectTeams).where(and(eq(schema.projectTeams.projectId, p.id), eq(schema.projectTeams.teamId, ta.id))), foreign);
  });

  test("nothing crosses workspaces: another workspace's team, lead or project", async () => {
    const [w2team] = await db.insert(schema.teams).values({ workspaceId: eve.workspaceId, key: `${L}X`, name: "Elsewhere" }).returning();
    const p = await project();
    await assert.rejects(db.insert(schema.projectTeams).values({ projectId: p.id, teamId: w2team.id, workspaceId: wsId }), foreign);
    await assert.rejects(db.insert(schema.projectTeams).values({ projectId: p.id, teamId: w2team.id, workspaceId: eve.workspaceId }), foreign);
    await assert.rejects(db.insert(schema.projects).values({ workspaceId: wsId, name: "lead outside", leadTeamId: ta.id, leadUserId: eve.id }), foreign);
    await assert.rejects(db.insert(schema.projectMilestones).values({ projectId: p.id, workspaceId: eve.workspaceId, name: "x", position: 1 }), foreign);
  });

  test("a lead who leaves the workspace is cleared; a project's dates cannot run backwards", async () => {
    const lead = await person(wsId, "member", "leaver");
    await join(ta, lead, "editor");
    const p = await project({ leadUser: lead.id });
    assert.equal(p.leadUser!.id, lead.id);
    await db.delete(schema.memberships).where(and(eq(schema.memberships.userId, lead.id), eq(schema.memberships.workspaceId, wsId)));
    assert.equal((await pr.getProject(ada, p.id)).leadUser, null);
    await assert.rejects(db.update(schema.projects).set({ startDate: "2026-05-02", targetDate: "2026-05-01" }).where(eq(schema.projects.id, p.id)), checked);
  });

  test("a status outside the five, and a health outside the three, are refused", async () => {
    const p = await project();
    await assert.rejects(db.execute(`update projects set status = 'later' where id = '${p.id}'` as never), checked);
    await assert.rejects(db.execute(`update projects set health_override = 'great' where id = '${p.id}'` as never), checked);
  });
});

describe("who sees a project (plan section 5)", () => {
  // P1: teams A (lead) and B. P2: team B only. A has 2 issues in P1 (1 done); B has 3 (1 done).
  let p1: pr.ProjectDetail;
  let p2: pr.ProjectDetail;
  before(async () => {
    p1 = await project({ name: "Shared delivery", teams: [tb.key] });
    p2 = await pr.createProject(ada, { name: "Beta only", leadTeam: tb.key });
    await issueIn(ta, p1.id, { title: "A-SECRET open", status: "Todo" });
    await issueIn(ta, p1.id, { title: "A-SECRET done", status: "Done" });
    await issueIn(tb, p1.id, { title: "B-SECRET done", status: "Done" });
    await issueIn(tb, p1.id, { title: "B-SECRET open one", status: "Todo" });
    await issueIn(tb, p1.id, { title: "B-SECRET open two", status: "In Progress" });
  });
  const ids = async (who: Actor) => (await pr.listProjects(who)).map((p) => p.id);

  test("a project is visible to people on any team that takes part, and to nobody else", async () => {
    assert.ok((await ids(bob)).includes(p1.id), "bob is on A");
    assert.ok(!(await ids(bob)).includes(p2.id), "P2 has only team B");
    assert.ok((await ids(cy)).includes(p1.id) && (await ids(cy)).includes(p2.id));
    assert.ok((await ids(ada)).includes(p1.id) && (await ids(ada)).includes(p2.id));
    assert.deepEqual((await ids(dee)).filter((i) => [p1.id, p2.id].includes(i)), [], "dee is on no team");
    await assert.rejects(pr.getProject(bob, p2.id), code("not_found"));
    await assert.rejects(pr.getProject(dee, p1.id), code("not_found"));
  });

  test("a guest sees no projects, even on a team that takes part", async () => {
    assert.deepEqual(await pr.listProjects(gus), []);
    await assert.rejects(pr.getProject(gus, p1.id), code("not_found"));
  });

  test("issue detail is shown only for the viewer's own teams; the others are counted, never named", async () => {
    const forBob = await pr.getProject(bob, p1.id);
    assert.deepEqual(forBob.teams.map((t) => t.key), [ta.key]);
    assert.deepEqual(forBob.teams[0].issues.map((t) => t.title).sort(), ["A-SECRET done", "A-SECRET open"]);
    assert.deepEqual(forBob.others, { count: 1, total: 3, done: 1 });
    assert.deepEqual([forBob.total, forBob.done], [5, 2], "the project's own totals count every team");
    const text = JSON.stringify(forBob);
    for (const leak of ["B-SECRET", tb.key, "Beta"]) assert.ok(!text.includes(leak), `bob's view must not contain ${leak}`);
    const forCy = await pr.getProject(cy, p1.id);
    assert.deepEqual(forCy.teams.map((t) => t.key), [tb.key]);
    assert.deepEqual(forCy.others, { count: 1, total: 2, done: 1 });
    assert.ok(!JSON.stringify(forCy).includes("A-SECRET") && !JSON.stringify(forCy).includes(ta.key));
    assert.equal(forCy.leadTeam, null, "the lead team is named only to people on it");
    assert.equal(forBob.leadTeam!.key, ta.key);
    const forAda = await pr.getProject(ada, p1.id);
    assert.deepEqual(forAda.teams.map((t) => t.key), [ta.key, tb.key]);
    assert.deepEqual(forAda.others, { count: 0, total: 0, done: 0 });
  });

  test("the list names no team the viewer is not on and counts nobody's titles", async () => {
    const mine = (await pr.listProjects(bob)).find((p) => p.id === p1.id)!;
    assert.equal(mine.teamCount, 2);
    assert.deepEqual([mine.total, mine.done], [5, 2]);
    assert.ok(!JSON.stringify(mine).includes("B-SECRET") && !JSON.stringify(mine).includes(tb.key));
  });

  test("a workspace viewer sees a project read-only; people in another workspace see nothing", async () => {
    const forVic = await pr.getProject(vic, p1.id);
    assert.equal(forVic.canEdit, false);
    await assert.rejects(pr.updateProject(vic, p1.id, { name: "renamed" }), code("forbidden"));
    assert.deepEqual(await pr.listProjects(eve), []);
    await assert.rejects(pr.getProject(eve, p1.id), code("not_found"));
    await assert.rejects(pr.createProject(eve, { name: "x", leadTeam: ta.id }), (e: unknown) => e instanceof ServiceError);
  });

  test("only the lead or an editor of the lead team changes a project; the lead team's admin changes who leads", async () => {
    assert.equal((await pr.getProject(bob, p1.id)).canEdit, true, "bob edits the lead team A");
    assert.equal((await pr.getProject(cy, p1.id)).canEdit, false, "cy is only on a contributing team");
    await assert.rejects(pr.updateProject(cy, p1.id, { description: "mine" }), code("forbidden"));
    await assert.rejects(pr.updateProject(bob, p1.id, { leadUser: cy.id }), code("forbidden")); // editors cannot change the lead
    assert.equal((await pr.updateProject(ada, p1.id, { leadUser: bob.id })).leadUser!.id, bob.id);
    assert.equal((await pr.updateProject(bob, p1.id, { leadUser: ada.id })).leadUser!.id, ada.id, "the lead can hand it back");
  });
});

describe("health and progress", () => {
  const P = (status: pr.ProjectRow["status"], startDate: string | null, targetDate: string | null) => ({ status, startDate, targetDate });
  const dealt = (done: number, total: number) => ({ total, done });

  test("only an active project has a derived health", () => {
    for (const status of ["planned", "paused", "completed", "canceled"] as const) assert.equal(pr.deriveHealth(P(status, "2026-11-01", "2026-12-01"), dealt(1, 4), D("2026-11-20")), null, status);
  });

  test("past the target with work open is off track; all done is on track whenever it is", () => {
    assert.equal(pr.deriveHealth(P("active", "2026-11-01", "2026-11-30"), dealt(3, 4), D("2026-12-01")), "off_track");
    assert.equal(pr.deriveHealth(P("active", "2026-11-01", "2026-11-30"), dealt(4, 4), D("2026-12-20")), "on_track");
    assert.equal(pr.deriveHealth(P("active", "2026-11-01", "2026-11-30"), dealt(0, 0), D("2026-12-01")), "off_track", "past the date with nothing to show for it");
    assert.equal(pr.deriveHealth(P("active", "2026-11-01", "2026-11-30"), dealt(1, 4), new Date(Date.parse("2026-11-30T23:00:00Z"))), "off_track", "the target day counts, then it is over: still on the last day, at risk or worse by the gap");
  });

  test("time gone against work done: a gap over a quarter is at risk, over a half is off track", () => {
    const p = P("active", "2026-11-01", "2026-11-11"); // ten days, the 11th counts: 11 days in all
    const at = (day: number) => new Date(Date.parse(`2026-11-${String(day).padStart(2, "0")}T00:00:00Z`));
    assert.equal(pr.deriveHealth(p, dealt(0, 10), at(2)), "on_track"); // 1 of 11 days gone, none done: gap 0.09
    assert.equal(pr.deriveHealth(p, dealt(0, 10), at(5)), "at_risk"); // 4 of 11: 0.36
    assert.equal(pr.deriveHealth(p, dealt(2, 10), at(8)), "at_risk"); // 7 of 11: 0.64 - 0.2 = 0.44
    assert.equal(pr.deriveHealth(p, dealt(1, 10), at(8)), "off_track"); // 0.64 - 0.1 = 0.54
    assert.equal(pr.deriveHealth(p, dealt(7, 10), at(8)), "on_track"); // ahead
    assert.equal(pr.deriveHealth(p, dealt(5, 10), at(1)), "on_track", "before it starts nothing is behind");
  });

  test("with only an end date, close and under half done is at risk; with no dates there is nothing to judge until there are issues", () => {
    assert.equal(pr.deriveHealth(P("active", null, "2026-11-10"), dealt(1, 4), D("2026-11-08")), "at_risk");
    assert.equal(pr.deriveHealth(P("active", null, "2026-11-10"), dealt(3, 4), D("2026-11-08")), "on_track");
    assert.equal(pr.deriveHealth(P("active", null, "2026-12-30"), dealt(0, 4), D("2026-11-08")), "on_track");
    assert.equal(pr.deriveHealth(P("active", null, null), dealt(0, 0), D("2026-11-08")), null);
    assert.equal(pr.deriveHealth(P("active", null, null), dealt(1, 3), D("2026-11-08")), "on_track");
  });

  test("a project's progress is the issues in it across its teams, and what people set wins over what is derived", async () => {
    const p = await pr.createProject(ada, { name: "Counted", leadTeam: ta.key, teams: [tb.key], status: "active", startDate: "2026-11-01", targetDate: "2026-11-30" });
    await issueIn(ta, p.id, { status: "Done" });
    await issueIn(ta, p.id, { status: "Todo" });
    await issueIn(tb, p.id, { status: "Done" });
    await issueIn(tb, p.id, { status: "Review" });
    const outside = await issueIn(tb, null, { status: "Done" });
    void outside;
    const view = (now: Date) => pr.getProject(ada, p.id, now);
    const early = await view(D("2026-11-03"));
    assert.deepEqual([early.total, early.done], [4, 2]);
    assert.deepEqual(early.health, { derived: "on_track", override: null, value: "on_track" });
    const late = await view(D("2026-12-02"));
    assert.deepEqual(late.health, { derived: "off_track", override: null, value: "off_track" });
    await pr.updateProject(ada, p.id, { healthOverride: "at_risk" });
    assert.deepEqual((await view(D("2026-11-03"))).health, { derived: "on_track", override: "at_risk", value: "at_risk" });
    assert.equal((await pr.updateProject(ada, p.id, { healthOverride: null })).health.override, null);
    const [row] = (await pr.listProjects(ada, D("2026-11-03"))).filter((x) => x.id === p.id);
    assert.deepEqual([row.total, row.done, row.health.value], [4, 2, "on_track"]);
    await pr.updateProject(ada, p.id, { status: "completed" });
    assert.equal((await view(D("2026-12-02"))).health.derived, null);
  });

  test("a done issue is one in a done status; a custom status counts as open", async () => {
    const p = await pr.createProject(ada, { name: "Statuses", leadTeam: ta.key });
    await issueIn(ta, p.id, { status: "Review" });
    await issueIn(ta, p.id, { status: "Done" });
    const v = await pr.getProject(ada, p.id);
    assert.deepEqual([v.total, v.done], [2, 1]);
  });
});

describe("the teams of a project", () => {
  test("a team is brought in by someone who can change the project and edits that team; nobody is pulled in", async () => {
    const p = await project();
    await assert.rejects(pr.addProjectTeam(bob, p.id, tb.key), code("not_found"), "bob is not on B, so it is not even there for him");
    await assert.rejects(pr.addProjectTeam(bob, p.id, tc.key), (e: unknown) => e instanceof ServiceError);
    await assert.rejects(pr.addProjectTeam(cy, p.id, tb.key), code("not_found"), "cy cannot see the project yet");
    const added = await pr.addProjectTeam(ada, p.id, tb.key);
    assert.equal(added.teamCount, 2);
    await assert.rejects(pr.addProjectTeam(ada, p.id, tb.key), code("conflict"));
    assert.deepEqual((await pr.getProject(ada, p.id)).addableTeams.map((t) => t.key), [tc.key]);
    assert.equal((await pr.getProject(bob, p.id)).addableTeams.length, 0, "bob edits only A, which is already in");
  });

  test("a team with issues in the project cannot leave until they are released, and they leave with it", async () => {
    const p = await project({ teams: [tb.key] });
    const m = (await pr.createMilestone(ada, p.id, { name: "M" })).milestones[0];
    const t = await issueIn(tb, p.id, { milestoneId: m.id });
    await assert.rejects(pr.removeProjectTeam(ada, p.id, tb.key), (e: unknown) => e instanceof ServiceError && e.code === "conflict" && /has 1 issue/.test(e.message));
    assert.equal((await getIssue(ada, t.ref)).issue.projectId, p.id, "nothing moved");
    const gone = await pr.removeProjectTeam(ada, p.id, tb.key, { releaseIssues: true });
    assert.deepEqual([gone.ok, gone.released], [true, 1]);
    const after = (await getIssue(ada, t.ref)).issue;
    assert.deepEqual([after.projectId, after.milestoneId], [null, null]);
    assert.equal((await pr.getProject(ada, p.id)).teamCount, 1);
  });

  test("the lead team cannot go; a team admin may take their own team out; an editor of another team may not", async () => {
    const p = await project({ teams: [tb.key] });
    await assert.rejects(pr.removeProjectTeam(ada, p.id, ta.key), (e: unknown) => /lead team/.test((e as Error).message));
    await assert.rejects(pr.removeProjectTeam(cy, p.id, tb.key), code("forbidden")); // cy edits B but does not run it
    await setTeamMemberRole(ada, tb.key, cy.id, "admin"); // now cy administers B
    assert.equal((await pr.removeProjectTeam(cy, p.id, tb.key)).ok, true, "a team may leave");
    await setTeamMemberRole(ada, tb.key, cy.id, "editor");
    await assert.rejects(pr.getProject(cy, p.id), code("not_found"), "and then it cannot see the project");
  });

  test("the lead team is changed to another team that takes part, by the lead or an admin of the lead team", async () => {
    const p = await project({ teams: [tb.key] });
    await assert.rejects(pr.updateProject(ada, p.id, { leadTeam: tc.key }), code("invalid"));
    assert.equal((await pr.updateProject(ada, p.id, { leadTeam: tb.key })).leadTeam!.key, tb.key);
    assert.equal((await pr.getProject(cy, p.id)).canEdit, true, "cy edits the new lead team");
    assert.equal((await pr.getProject(bob, p.id)).canEdit, false);
  });

  test("a team that leads a live project cannot be deleted; one that led a deleted project can", async () => {
    const lonely = await createTeam(ada, { name: "Lonely", key: `${L}L` });
    const lp = await pr.createProject(ada, { name: "Led by lonely", leadTeam: lonely.key });
    await assert.rejects(deleteTeam(ada, lonely.key), (e: unknown) => e instanceof ServiceError && e.code === "conflict" && /Led by lonely/.test(e.message));
    await pr.deleteProject(ada, lp.id);
    assert.deepEqual(await deleteTeam(ada, lonely.key), { ok: true, deleted: lonely.key });
    assert.equal((await db.select().from(schema.projects).where(eq(schema.projects.id, lp.id))).length, 0, "the deleted project went with it");
    const other = await createTeam(ada, { name: "Contributor", key: `${L}K` });
    const p = await pr.createProject(ada, { name: "Has a contributor", leadTeam: ta.key, teams: [other.key] });
    await deleteTeam(ada, other.key);
    assert.equal((await pr.getProject(ada, p.id)).teamCount, 1);
  });
});

describe("milestones and an issue's place in a project", () => {
  test("milestones are ordered, renamed, moved and deleted; their counts are the issues in them", async () => {
    const p = await project();
    let v = await pr.createMilestone(ada, p.id, { name: "Alpha", targetDate: "2026-11-15" });
    v = await pr.createMilestone(ada, p.id, { name: "Beta", description: "Public" });
    v = await pr.createMilestone(ada, p.id, { name: "GA" });
    assert.deepEqual(v.milestones.map((m) => m.name), ["Alpha", "Beta", "GA"]);
    const [alpha, beta, ga] = v.milestones;
    v = await pr.updateMilestone(ada, p.id, ga.id, { index: 0 });
    assert.deepEqual(v.milestones.map((m) => m.name), ["GA", "Alpha", "Beta"]);
    v = await pr.updateMilestone(ada, p.id, alpha.id, { name: "Alpha 1", targetDate: null });
    assert.deepEqual([v.milestones[1].name, v.milestones[1].targetDate], ["Alpha 1", null]);
    await issueIn(ta, p.id, { milestoneId: beta.id, status: "Done" });
    await issueIn(ta, p.id, { milestoneId: beta.id });
    v = await pr.getProject(ada, p.id);
    assert.deepEqual(v.milestones.map((m) => [m.name, m.total, m.done]), [["GA", 0, 0], ["Alpha 1", 0, 0], ["Beta", 2, 1]]);
    await assert.rejects(pr.updateMilestone(ada, p.id, beta.id, { index: -1 }), code("invalid"));
    await assert.rejects(pr.updateMilestone(ada, p.id, "not-an-id", { name: "x" }), code("not_found"));
    await assert.rejects(pr.createMilestone(ada, p.id, { name: " " }), code("invalid"));
    v = await pr.deleteMilestone(ada, p.id, beta.id);
    assert.equal(v.milestones.length, 2);
    assert.equal(v.total, 2, "its issues stay in the project");
    assert.equal(v.milestones.every((m) => m.total === 0), true);
  });

  test("another project's milestone cannot be changed through this one", async () => {
    const p1 = await project();
    const p2 = await project();
    const m = (await pr.createMilestone(ada, p2.id, { name: "Theirs" })).milestones[0];
    await assert.rejects(pr.updateMilestone(ada, p1.id, m.id, { name: "hijack" }), code("not_found"));
    await assert.rejects(pr.deleteMilestone(ada, p1.id, m.id), code("not_found"));
    assert.equal((await pr.getProject(ada, p2.id)).milestones[0].name, "Theirs");
  });

  test("changing an issue's project drops its milestone, a milestone alone keeps the project, and null leaves", async () => {
    const p1 = await project({ teams: [tb.key] });
    const p2 = await project();
    const m1 = (await pr.createMilestone(ada, p1.id, { name: "One" })).milestones[0];
    const t = await issueIn(ta, p1.id, { milestoneId: m1.id });
    assert.deepEqual([t.projectId, t.milestoneId], [p1.id, m1.id]);
    const moved = await updateIssue(ada, t.ref, { projectId: p2.id });
    assert.deepEqual([moved.projectId, moved.milestoneId], [p2.id, null]);
    const back = await updateIssue(ada, t.ref, { projectId: p1.id, milestoneId: m1.id });
    assert.deepEqual([back.projectId, back.milestoneId], [p1.id, m1.id]);
    const same = await updateIssue(ada, t.ref, { projectId: p1.id });
    assert.equal(same.version, back.version, "the same project keeps its milestone and changes nothing");
    const out = await updateIssue(ada, t.ref, { projectId: null });
    assert.deepEqual([out.projectId, out.milestoneId], [null, null]);
  });

  test("an issue joining or leaving a project is said to its team, and to nobody else's", async () => {
    const p = await project({ name: "Said" });
    const t = await issueIn(ta, null);
    await updateIssue(ada, t.ref, { projectId: p.id });
    await updateIssue(ada, t.ref, { projectId: null });
    const mine = (await db.select().from(schema.events).where(and(eq(schema.events.teamId, ta.id), eq(schema.events.entityId, p.id)))).map((e) => e.type);
    assert.deepEqual(mine.filter((x) => x.startsWith("project.issue")), ["project.issue_joined", "project.issue_left"]);
    assert.deepEqual((await db.select().from(schema.events).where(and(eq(schema.events.teamId, tb.id), eq(schema.events.entityId, p.id)))).length, 0);
  });
});

describe("changing and deleting a project", () => {
  test("an edit with a stale version is a conflict that shows the project as it is; the same values change nothing", async () => {
    const p = await project();
    const a = await pr.updateProject(ada, p.id, { name: "Renamed", version: p.version });
    assert.deepEqual([a.name, a.version], ["Renamed", p.version + 1]);
    await assert.rejects(pr.updateProject(ada, p.id, { name: "Late", version: p.version }), (e: unknown) => e instanceof ServiceError && e.code === "conflict");
    assert.equal((await pr.updateProject(ada, p.id, { name: "Renamed" })).version, a.version, "nothing changed");
    await assert.rejects(pr.updateProject(ada, p.id, { targetDate: "2020-01-01", startDate: "2021-01-01" }), code("invalid"));
  });

  test("updates are announced to the workspace; a change of status or date is also told to the teams", async () => {
    const p = await project({ teams: [tb.key] });
    await pr.updateProject(ada, p.id, { description: "words" });
    await pr.updateProject(ada, p.id, { status: "active" });
    const ws = (await db.select().from(schema.workspaceEvents).where(eq(schema.workspaceEvents.entityId, p.id))).map((e) => e.type);
    assert.deepEqual(ws, ["project.created", "project.updated", "project.updated"]);
    const toB = (await db.select().from(schema.events).where(and(eq(schema.events.teamId, tb.id), eq(schema.events.entityId, p.id)))).map((e) => e.type);
    assert.deepEqual(toB, ["project.created", "project.status_changed"]);
  });

  test("deleting hides the project, keeps the issues on their boards in no project, and needs the lead or a lead team admin", async () => {
    const p = await project({ teams: [tb.key] });
    const m = (await pr.createMilestone(ada, p.id, { name: "M" })).milestones[0];
    const a = await issueIn(ta, p.id, { milestoneId: m.id });
    const b = await issueIn(tb, p.id);
    await assert.rejects(pr.deleteProject(bob, p.id), code("forbidden"), "bob is an editor of the lead team, not its admin");
    const gone = await pr.deleteProject(ada, p.id);
    assert.deepEqual([gone.ok, gone.released], [true, 2]);
    for (const ref of [a.ref, b.ref]) assert.deepEqual([(await getIssue(ada, ref)).issue.projectId, (await getIssue(ada, ref)).issue.milestoneId], [null, null]);
    assert.ok(!(await pr.listProjects(ada)).some((x) => x.id === p.id));
    await assert.rejects(pr.getProject(ada, p.id), code("not_found"));
    await assert.rejects(issueIn(ta, p.id), (e: unknown) => /does not exist/.test((e as Error).message));
    assert.equal((await db.select().from(schema.projects).where(eq(schema.projects.id, p.id))).length, 1, "a soft delete keeps the row");
  });

  test("the board of a team names the projects it takes part in, with milestones, and no others", async () => {
    const mine = await project({ name: "On A's board", teams: [tb.key] });
    await pr.createMilestone(ada, mine.id, { name: "Step" });
    const bOnly = await pr.createProject(ada, { name: "Only B", leadTeam: tb.key });
    const opts = await pr.projectsOfTeam(ta.id);
    assert.ok(opts.some((o) => o.id === mine.id && o.milestones.map((m) => m.name).join() === "Step"));
    assert.ok(!opts.some((o) => o.id === bOnly.id));
  });
});
