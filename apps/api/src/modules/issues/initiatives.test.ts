/**
 * Initiatives (WH-119) against a real database: nesting to three levels with no cycle, the roll-up counting an issue once, what an
 * initiative shows of a project (full for the viewer's teams, totals for the rest, never an issue), guests, and the append-only
 * workspace_events. Runs on an in-memory PGlite (`pnpm test`), or a real Postgres with TEST_DATABASE_URL.
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  process.env.PGLITE_DIR = "memory://";
  delete process.env.DATABASE_URL;
}

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../../db";
import type { TeamRole, WorkspaceRole } from "../../db/schema";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { createTeam } from "../teams/teams";
import { IssueInput, createIssue } from "./issues";
import * as pr from "./projects";
import * as ini from "./initiatives";
import { addTeamMember } from "../teams/team-members";
import { testApp } from "../../test/app";
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
  await join(ta, bob, "editor");
  await join(tb, cy, "editor");
  await join(ta, gus, "viewer");
  await join(ta, vic, "editor");
  ta = await teamRow(`${L}A`);
  tb = await teamRow(`${L}B`);
});

const project = (over: Record<string, unknown> = {}, as: Actor = ada) => pr.createProject(as, { name: `P ${++n}`, leadTeam: ta.key, ...over });
const issueIn = (team: { key: string }, projectId: string | null, over: Partial<IssueInput> & { status?: string } = {}) => createIssue(ada, team.key, { title: `t ${++n}`, projectId, ...over });
const make = (over: Record<string, unknown> = {}, as: Actor = ada) => ini.createInitiative(as, { name: `I ${++n}`, ...over });
const events = (entityId: string) => db.select().from(schema.workspaceEvents).where(eq(schema.workspaceEvents.entityId, entityId)).orderBy(schema.workspaceEvents.seq);

describe("nesting", () => {
  test("a top initiative has the creator as owner; up to three levels are fine, a fourth is refused", async () => {
    const top = await make();
    assert.equal(top.owner?.id, ada.id);
    assert.equal(top.depth, 1);
    const mid = await make({ parentId: top.id });
    const low = await make({ parentId: mid.id });
    assert.equal(low.depth, 3);
    assert.deepEqual(low.path.map((p) => p.id), [top.id, mid.id]);
    await assert.rejects(make({ parentId: low.id }), code("invalid"));
    assert.equal((await ini.getInitiative(ada, top.id)).childCount, 1);
  });

  test("a move cannot form a cycle, put one under itself, or take a branch past three levels", async () => {
    const a = await make();
    const b = await make({ parentId: a.id });
    const c = await make({ parentId: b.id });
    await assert.rejects(ini.updateInitiative(ada, a.id, { parentId: c.id }), code("invalid"));
    await assert.rejects(ini.updateInitiative(ada, a.id, { parentId: a.id }), code("invalid"));
    await assert.rejects(ini.updateInitiative(ada, b.id, { parentId: c.id }), code("invalid"));
    // a (with b and c under it, three levels) cannot go under another initiative: that would be four
    const other = await make();
    await assert.rejects(ini.updateInitiative(ada, a.id, { parentId: other.id }), code("invalid"));
    // but the branch b-c (two levels) can go under a top initiative
    const moved = await ini.updateInitiative(ada, b.id, { parentId: other.id });
    assert.equal(moved.parentId, other.id);
    assert.equal((await ini.getInitiative(ada, c.id)).depth, 3);
    assert.equal((await ini.getInitiative(ada, a.id)).childCount, 0);
  });

  test("the database refuses an initiative that is its own parent and a parent from another workspace", async () => {
    const a = await make();
    await assert.rejects(db.update(schema.initiatives).set({ parentId: a.id }).where(eq(schema.initiatives.id, a.id)), checked);
    const [theirs] = await db.insert(schema.initiatives).values({ workspaceId: eve.workspaceId, name: "theirs" }).returning();
    await assert.rejects(db.update(schema.initiatives).set({ parentId: theirs.id }).where(eq(schema.initiatives.id, a.id)), foreign);
  });

  test("deleting an initiative moves its children up and leaves the projects alone", async () => {
    const top = await make();
    const mid = await make({ parentId: top.id });
    const low = await make({ parentId: mid.id });
    const p = await project();
    await ini.linkProject(ada, mid.id, p.id);
    const gone = await ini.deleteInitiative(ada, mid.id);
    assert.deepEqual([gone.moved, gone.unlinked], [1, 1]);
    assert.equal((await ini.getInitiative(ada, low.id)).parentId, top.id);
    await assert.rejects(ini.getInitiative(ada, mid.id), code("not_found"));
    assert.equal((await pr.getProject(ada, p.id)).name, p.name, "the project is still there");
    assert.equal((await db.select().from(schema.initiativeProjects).where(eq(schema.initiativeProjects.initiativeId, mid.id))).length, 0);
  });

  test("siblings can be put in a chosen order", async () => {
    const top = await make();
    const x = await make({ parentId: top.id, name: "x" });
    const y = await make({ parentId: top.id, name: "y" });
    const z = await make({ parentId: top.id, name: "z" });
    await ini.updateInitiative(ada, z.id, { index: 0 });
    assert.deepEqual((await ini.getInitiative(ada, top.id)).children.map((c) => c.name), ["z", "x", "y"]);
    await ini.updateInitiative(ada, z.id, { index: 2 });
    assert.deepEqual((await ini.getInitiative(ada, top.id)).children.map((c) => c.name), ["x", "y", "z"]);
    assert.ok(x && y);
  });
});

describe("roll-up", () => {
  test("progress comes from the projects below, and an issue counts once when two links reach its project", async () => {
    const top = await make({ status: "active" });
    const left = await make({ parentId: top.id });
    const right = await make({ parentId: top.id });
    const shared = await project();
    const only = await project();
    await issueIn(ta, shared.id, { status: "Done" });
    await issueIn(ta, shared.id);
    await issueIn(ta, only.id, { status: "Done" });
    await ini.linkProject(ada, left.id, shared.id);
    await ini.linkProject(ada, right.id, shared.id);
    await ini.linkProject(ada, top.id, shared.id);
    await ini.linkProject(ada, right.id, only.id);
    const t = await ini.getInitiative(ada, top.id);
    assert.deepEqual([t.total, t.done], [3, 2], "three issues, however many links lead to them");
    assert.deepEqual([t.projects.length, t.hidden.count], [2, 0]);
    const l = await ini.getInitiative(ada, left.id);
    assert.deepEqual([l.total, l.done], [2, 1]);
    const r = await ini.getInitiative(ada, right.id);
    assert.deepEqual([r.total, r.done], [3, 2]);
    const list = await ini.listInitiatives(ada);
    const row = list.find((x) => x.id === top.id)!;
    assert.deepEqual([row.total, row.done, row.projectCount, row.childCount], [3, 2, 1, 2]);
  });

  test("a deleted project and a deleted sub-initiative stop counting", async () => {
    const top = await make();
    const sub = await make({ parentId: top.id });
    const p = await project();
    await issueIn(ta, p.id);
    await ini.linkProject(ada, sub.id, p.id);
    assert.equal((await ini.getInitiative(ada, top.id)).total, 1);
    await pr.deleteProject(ada, p.id);
    assert.equal((await ini.getInitiative(ada, top.id)).total, 0);
    const q = await project();
    await issueIn(ta, q.id);
    await ini.linkProject(ada, sub.id, q.id);
    assert.equal((await ini.getInitiative(ada, top.id)).total, 1);
    await ini.deleteInitiative(ada, sub.id);
    assert.equal((await ini.getInitiative(ada, top.id)).total, 0, "its links went with it");
  });

  test("health is worked out from the target date on a fixed clock, and a hand-set one wins", async () => {
    const top = await make({ status: "active", targetDate: "2026-11-30" });
    const p = await project();
    await issueIn(ta, p.id);
    await issueIn(ta, p.id, { status: "Done" });
    await ini.linkProject(ada, top.id, p.id);
    const before = await ini.getInitiative(ada, top.id, D("2026-11-10"));
    assert.equal(before.health.derived, "on_track");
    const after = await ini.getInitiative(ada, top.id, D("2026-12-02"));
    assert.deepEqual([after.health.derived, after.health.value], ["off_track", "off_track"]);
    const set = await ini.updateInitiative(ada, top.id, { healthOverride: "at_risk" }, D("2026-12-02"));
    assert.deepEqual([set.health.derived, set.health.override, set.health.value], ["off_track", "at_risk", "at_risk"]);
    const cleared = await ini.updateInitiative(ada, top.id, { healthOverride: null }, D("2026-12-02"));
    assert.equal(cleared.health.override, null);
    const paused = await ini.updateInitiative(ada, top.id, { status: "paused" }, D("2026-12-02"));
    assert.equal(paused.health.value, null, "only an active initiative has a health");
  });
});

describe("who sees what", () => {
  test("a person on no team of a project sees only its totals inside an initiative, never a name or an issue", async () => {
    const top = await make({ status: "active" });
    const secret = await project({ name: "SECRET-PROJECT", leadTeam: tb.key });
    const open = await project({ name: "open-project", leadTeam: ta.key });
    await issueIn(tb, secret.id, { title: "SECRET-ISSUE", status: "Done" });
    await issueIn(tb, secret.id, { title: "SECRET-ISSUE-2" });
    await issueIn(ta, open.id, { title: "open-issue" });
    await ini.linkProject(ada, top.id, secret.id);
    await ini.linkProject(ada, top.id, open.id);
    const forBob = await ini.getInitiative(bob, top.id); // bob is on A only
    assert.deepEqual(forBob.projects.map((p) => p.name), ["open-project"]);
    assert.deepEqual(forBob.hidden, { count: 1, total: 2, done: 1 });
    assert.deepEqual([forBob.total, forBob.done], [3, 1], "the roll-up still counts every project");
    const text = JSON.stringify([forBob, await ini.listInitiatives(bob)]);
    for (const leak of ["SECRET-PROJECT", "SECRET-ISSUE", "open-issue"]) assert.ok(!text.includes(leak), `${leak} must not appear`);
    const forAda = await ini.getInitiative(ada, top.id);
    assert.deepEqual(forAda.projects.map((p) => p.name).sort(), ["SECRET-PROJECT", "open-project"]);
    assert.equal(forAda.hidden.count, 0);
    assert.ok(!JSON.stringify(forAda).includes("SECRET-ISSUE"), "no initiative page ever lists an issue");
    const forDee = await ini.getInitiative(dee, top.id); // on no team at all: sees the initiative, only totals
    assert.deepEqual([forDee.projects.length, forDee.hidden.count], [0, 2]);
  });

  test("guests see no initiatives and cannot open one; other workspaces see none either", async () => {
    const top = await make();
    assert.deepEqual(await ini.listInitiatives(gus), []);
    await assert.rejects(ini.getInitiative(gus, top.id), code("not_found"));
    await assert.rejects(make({}, gus), code("not_found"));
    assert.ok(!(await ini.listInitiatives(eve)).some((i) => i.id === top.id));
    await assert.rejects(ini.getInitiative(eve, top.id), code("not_found"));
    await assert.rejects(ini.updateInitiative(eve, top.id, { name: "defaced" }), code("not_found"));
    await assert.rejects(ini.deleteInitiative(eve, top.id), code("not_found"));
    await assert.rejects(ini.linkProject(eve, top.id, (await project()).id), code("not_found"));
    await assert.rejects(make({ parentId: top.id }, eve), code("invalid"), "a parent of another workspace does not exist for them");
  });

  test("agents and system actors cannot work with initiatives", async () => {
    await assert.rejects(ini.listInitiatives({ ...ada, kind: "agent" }), code("forbidden"));
    await assert.rejects(make({}, { ...ada, system: true } as Actor), code("forbidden"));
  });

  test("anyone but a guest or a viewer can create; only the owner or an admin can change one", async () => {
    const mine = await make({ name: "bob's" }, bob);
    assert.equal(mine.owner?.id, bob.id);
    assert.equal(mine.canEdit, true);
    await assert.rejects(make({}, vic), code("forbidden"));
    const asCy = await ini.getInitiative(cy, mine.id);
    assert.equal(asCy.canEdit, false);
    await assert.rejects(ini.updateInitiative(cy, mine.id, { name: "mine now" }), code("forbidden"));
    await assert.rejects(ini.deleteInitiative(cy, mine.id), code("forbidden"));
    await assert.rejects(make({ parentId: mine.id }, cy), code("forbidden"));
    assert.equal((await ini.updateInitiative(ada, mine.id, { name: "renamed by the owner of the workspace" })).name, "renamed by the owner of the workspace");
    assert.equal((await ini.updateInitiative(ada, mine.id, { owner: cy.id })).owner?.id, cy.id);
    await assert.rejects(ini.updateInitiative(ada, mine.id, { owner: gus.id }), code("invalid"), "a guest cannot own one");
    assert.equal((await ini.getInitiative(cy, mine.id)).canEdit, true);
  });

  test("a project can be linked only by someone who sees it, and once", async () => {
    const top = await make({}, bob);
    const hidden = await project({ leadTeam: tb.key });
    await assert.rejects(ini.linkProject(bob, top.id, hidden.id), code("not_found"));
    const mine = await project({ leadTeam: ta.key });
    const offered = (await ini.getInitiative(bob, top.id)).linkable.map((p) => p.id);
    assert.ok(offered.includes(mine.id) && !offered.includes(hidden.id), "only projects the person sees are offered");
    await ini.linkProject(bob, top.id, mine.id);
    await assert.rejects(ini.linkProject(bob, top.id, mine.id), code("conflict"));
    await assert.rejects(ini.linkProject(bob, top.id, "nope"), code("invalid"));
    assert.ok(!(await ini.getInitiative(bob, top.id)).linkable.some((p) => p.id === mine.id), "a linked project is not offered again");
    const back = await ini.unlinkProject(bob, top.id, mine.id);
    assert.equal(back.projects.length, 0);
    await assert.rejects(ini.unlinkProject(bob, top.id, mine.id), code("not_found"));
  });
});

describe("editing", () => {
  test("field checks, and a stale version is a conflict", async () => {
    await assert.rejects(make({ name: "  " }), code("invalid"));
    await assert.rejects(make({ status: "completed" }), code("invalid"));
    await assert.rejects(make({ targetDate: "2026-02-30" }), code("invalid"));
    await assert.rejects(make({ healthOverride: "great" }), code("invalid"));
    const i = await make();
    const u = await ini.updateInitiative(ada, i.id, { name: "x", version: i.version });
    assert.equal(u.version, i.version + 1);
    await assert.rejects(ini.updateInitiative(ada, i.id, { name: "y", version: i.version }), code("conflict"));
    const same = await ini.updateInitiative(ada, i.id, { name: "x" });
    assert.equal(same.version, u.version, "no change, no new version");
  });
});

describe("workspace_events", () => {
  test("initiative changes are logged, in order, with who did them", async () => {
    const top = await make({ name: "logged" });
    const p = await project();
    await ini.updateInitiative(ada, top.id, { status: "active" });
    await ini.linkProject(ada, top.id, p.id);
    await ini.unlinkProject(ada, top.id, p.id);
    await ini.deleteInitiative(ada, top.id);
    const log = await events(top.id);
    assert.deepEqual(log.map((e) => e.type), ["initiative.created", "initiative.updated", "initiative.project_linked", "initiative.project_unlinked", "initiative.deleted"]);
    assert.ok(log.every((e) => e.entity === "initiative" && e.workspaceId === wsId && e.actorId === ada.id && e.actorName === "ada"));
    assert.deepEqual(log[1].data.changed, ["status"]);
    assert.ok(log.every((e, i) => i === 0 || e.seq > log[i - 1].seq));
  });

  test("the log is append-only: no row can be changed or removed, by a stray statement", async () => {
    const top = await make();
    const [e] = await events(top.id);
    const refused = (x: unknown) => (x as { cause?: { message?: string } }).cause?.message?.includes("append-only") || (x as Error).message.includes("append-only");
    await assert.rejects(db.update(schema.workspaceEvents).set({ summary: "rewritten" }).where(eq(schema.workspaceEvents.seq, e.seq)), refused);
    await assert.rejects(db.delete(schema.workspaceEvents).where(eq(schema.workspaceEvents.seq, e.seq)), refused);
    assert.equal((await events(top.id))[0].summary, e.summary);
  });

  test("deleting a whole workspace still clears its log", async () => {
    const [w] = await db.insert(schema.workspaces).values({ name: `gone ${RUN}` }).returning();
    const boss = await person(w.id, "owner", "boss");
    const i = await make({}, boss);
    assert.equal((await events(i.id)).length, 1);
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, w.id));
    assert.equal((await events(i.id)).length, 0);
  });
});
