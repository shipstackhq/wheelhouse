/**
 * Cycles (WH-117) against a real database, on a fixed clock: an issue joins only its own team's cycle, the end of a cycle hands
 * its unfinished issues on exactly once, and the cycle view and the "what landed" report match what really moved to Done.
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
import { getDb, schema } from "../../db";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { createTeam } from "../teams/teams";
import { IssueInput, createIssue, deleteIssue, getBoard, getIssue, moveIssue, updateIssue } from "./issues";
import * as cy from "./cycles";
import { testApp } from "../../test/app";
await testApp();

const RUN = Math.random().toString(16).slice(2, 8);
const L = RUN.replace(/[0-9]/g, (c) => "ghijklmnop"[Number(c)]).slice(0, 2).toUpperCase();
const refusedWith = (code: string) => (e: unknown) => (e as { cause?: { code?: string } }).cause?.code === code;
const foreign = refusedWith("23503");
const checked = refusedWith("23514");
const code = (c: ServiceError["code"]) => (e: unknown) => e instanceof ServiceError && e.code === c;

const D = (s: string) => new Date(`${s}T12:00:00.000Z`);
const DAY = 86_400_000;
// Joining a cycle uses the real clock (a cycle that has ended is closed), so the tests that put issues in cycles hang their windows
// on this moment; the clock the cycle functions are given is then set a known number of days after it.
const T0 = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
const at = (days: number) => new Date(T0.getTime() + days * DAY);

let db: Awaited<ReturnType<typeof getDb>>;
let ada: Actor; // owner, admin of both teams
let vic: Actor; // a viewer of team A
let a: { id: string; workspaceId: string; key: string };
let b: { id: string; workspaceId: string; key: string };
let n = 0;

before(async () => {
  db = await getDb();
  const [w] = await db.insert(schema.workspaces).values({ name: `cyc ${RUN}` }).returning();
  const mk = async (name: string, role: "owner" | "member"): Promise<Actor> => {
    const [u] = await db.insert(schema.users).values({ email: `${name}-${RUN}@example.com`, name, passwordHash: "x" }).returning();
    await db.insert(schema.memberships).values({ userId: u.id, workspaceId: w.id, role });
    return { kind: "human", id: u.id, name, workspaceId: w.id };
  };
  ada = await mk("ada", "owner");
  vic = await mk("vic", "member");
  a = await createTeam(ada, { name: "Alpha", key: `${L}A` });
  b = await createTeam(ada, { name: "Beta", key: `${L}B` });
  const { addTeamMember } = await import("../teams/team-members");
  await addTeamMember(ada, a.key, { userId: vic.id, role: "viewer" });
});

const issue = async (team: { key: string }, title: string, over: Partial<IssueInput> & { status?: string } = {}) => createIssue(ada, team.key, { title: `${title} ${++n}`, ...over });
const cycleRow = async (team: { id: string }, number: number) => (await db.select().from(schema.cycles).where(and(eq(schema.cycles.teamId, team.id), eq(schema.cycles.number, number))))[0];
const cycleOf = async (ref: string) => (await getIssue(ada, ref)).issue.cycle;

describe("making cycles", () => {
  test("a cycle is numbered per team, with a goal, and shows up as upcoming, current or past against the clock", async () => {
    const now = T0;
    const one = await cy.createCycle(ada, a.key, { name: "Spring", goal: "Ship billing", startsAt: at(-1), endsAt: at(13) }, now);
    const two = await cy.createCycle(ada, a.key, { startsAt: at(13), endsAt: at(27) }, now);
    const other = await cy.createCycle(ada, b.key, { startsAt: at(-1), endsAt: at(6) }, now);
    assert.deepEqual([one.number, two.number, other.number], [1, 2, 1], "numbers count per team");
    assert.deepEqual([one.state, two.state], ["current", "upcoming"]);
    assert.equal(one.goal, "Ship billing");
    const list = await cy.listCycles(ada, a.key, now);
    assert.equal(list.current!.number, 1);
    assert.deepEqual(list.upcoming.map((c) => c.number), [2]);
    assert.equal(list.past.length, 0);
    assert.deepEqual([one, two].map((c) => cy.stateOf(c, at(30))), ["past", "past"], "a month on, both are past");
  });

  test("a window is one to fourteen days and ends after it starts", async () => {
    const t = await createTeam(ada, { name: "Windows", key: `${L}W` });
    const now = D("2026-05-01");
    await assert.rejects(cy.createCycle(ada, t.key, { startsAt: D("2026-05-02"), endsAt: D("2026-05-01") }, now), code("invalid"));
    await assert.rejects(cy.createCycle(ada, t.key, { startsAt: D("2026-05-01"), endsAt: new Date(D("2026-05-01").getTime() + 3600_000) }, now), (e: unknown) => /at least one day/.test((e as Error).message));
    await assert.rejects(cy.createCycle(ada, t.key, { startsAt: D("2026-05-01"), endsAt: D("2026-05-20") }, now), (e: unknown) => /at most two weeks/.test((e as Error).message));
    await assert.rejects(cy.createCycle(ada, t.key, { startsAt: "not a date" }, now), code("invalid"));
    const open = await cy.createCycle(ada, t.key, {}, now);
    assert.equal(open.endsAt.getTime() - open.startsAt.getTime(), 14 * DAY, "with no dates, two weeks from now");
    assert.equal(open.state, "current");
  });

  test("the database refuses an end that is not after the start", async () => {
    await assert.rejects(db.insert(schema.cycles).values({ teamId: a.id, workspaceId: a.workspaceId, number: 99, startsAt: D("2026-01-02"), endsAt: D("2026-01-01") }), checked);
  });

  test("cycles of a team do not overlap; touching is fine; another team may use the same days", async () => {
    const t = await createTeam(ada, { name: "Overlap", key: `${L}O` });
    const now = D("2026-06-01");
    await cy.createCycle(ada, t.key, { startsAt: D("2026-06-01"), endsAt: D("2026-06-08") }, now);
    await assert.rejects(cy.createCycle(ada, t.key, { startsAt: D("2026-06-07"), endsAt: D("2026-06-14") }, now), code("conflict"));
    await assert.rejects(cy.createCycle(ada, t.key, { startsAt: D("2026-05-30"), endsAt: D("2026-06-02") }, now), code("conflict"));
    assert.equal((await cy.createCycle(ada, t.key, { startsAt: D("2026-06-08"), endsAt: D("2026-06-15") }, now)).number, 2, "it starts the moment the other ends");
    await assert.rejects(cy.updateCycle(ada, t.key, 2, { startsAt: D("2026-06-05") }, now), code("conflict"));
    const moved = await cy.updateCycle(ada, t.key, 2, { endsAt: D("2026-06-12"), goal: "Shorter" }, now);
    assert.deepEqual([moved.goal, moved.endsAt.toISOString()], ["Shorter", D("2026-06-12").toISOString()]);
  });

  test("two people creating at once cannot both get the same days", async () => {
    const t = await createTeam(ada, { name: "Race", key: `${L}R` });
    const now = D("2026-07-01");
    const results = await Promise.allSettled([1, 2, 3].map(() => cy.createCycle(ada, t.key, { startsAt: D("2026-07-01"), endsAt: D("2026-07-08") }, now)));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await db.select().from(schema.cycles).where(eq(schema.cycles.teamId, t.id))).length, 1);
  });

  test("a viewer reads cycles but cannot change them; another workspace's team is not found", async () => {
    const now = T0;
    assert.ok((await cy.listCycles(vic, a.key, now)).current);
    await assert.rejects(cy.createCycle(vic, a.key, {}, now), code("forbidden"));
    await assert.rejects(cy.updateCycle(vic, a.key, 1, { goal: "x" }, now), code("forbidden"));
    await assert.rejects(cy.deleteCycle(vic, a.key, 1), code("forbidden"));
    const [w2] = await db.insert(schema.workspaces).values({ name: `cyc other ${RUN}` }).returning();
    const outsider: Actor = { kind: "human", id: ada.id, name: "x", workspaceId: w2.id };
    await assert.rejects(cy.listCycles(outsider, a.key, now), code("not_found"));
  });
});

describe("issues in cycles", () => {
  test("an issue joins and leaves its own team's cycle, which shows on the issue and the board", async () => {
    const t = await issue(a, "joins", { cycle: 1 });
    assert.equal(t.cycle, 1);
    assert.equal(await cycleOf(t.ref), 1);
    assert.equal((await getBoard(ada, a.key)).issues.find((x) => x.id === t.id)!.cycle, 1);
    const left = await updateIssue(ada, t.ref, { cycle: null });
    assert.equal(left.cycle, null);
    const back = await updateIssue(ada, t.ref, { cycle: 2 });
    assert.equal(back.cycle, 2);
    const [ev] = await db.select().from(schema.events).where(and(eq(schema.events.entityId, t.id), eq(schema.events.type, "issue.updated")));
    assert.ok(ev.summary.includes("cycle"));
  });

  test("an issue cannot be put in another team's cycle: the service refuses, and so does the database", async () => {
    const t = await issue(a, "stays home");
    await assert.rejects(updateIssue(ada, t.ref, { cycle: 99 }), (e: unknown) => /no cycle 99/.test((e as Error).message));
    const theirs = await cycleRow(b, 1);
    // number 1 exists in both teams; the service resolves it in the issue's own team, never in the other
    assert.equal((await updateIssue(ada, t.ref, { cycle: 1 })).cycle, 1);
    assert.equal((await db.select().from(schema.issues).where(eq(schema.issues.id, t.id)))[0].cycleId, (await cycleRow(a, 1)).id);
    await assert.rejects(db.update(schema.issues).set({ cycleId: theirs.id }).where(eq(schema.issues.id, t.id)), foreign);
    await assert.rejects(issue(a, "born elsewhere", { cycle: 77 }), code("invalid"));
  });

  test("a cycle that has ended is closed to new issues", async () => {
    const t = await createTeam(ada, { name: "Closed", key: `${L}C` });
    const now = new Date();
    const past = await cy.createCycle(ada, t.key, { startsAt: new Date(now.getTime() - 5 * DAY), endsAt: new Date(now.getTime() - 2 * DAY) }, new Date(now.getTime() - 4 * DAY));
    await assert.rejects(createIssue(ada, t.key, { title: "late", cycle: past.number }), (e: unknown) => /has ended/.test((e as Error).message));
  });

  test("deleting a cycle takes its issues out of it and leaves them on the board", async () => {
    const t = await createTeam(ada, { name: "Deletes", key: `${L}D` });
    await cy.createCycle(ada, t.key, { startsAt: at(-1), endsAt: at(6) }, T0);
    const x = await createIssue(ada, t.key, { title: "x", cycle: 1 });
    const gone = await cy.deleteCycle(ada, t.key, 1);
    assert.deepEqual([gone.ok, gone.released], [true, 1]);
    const after = (await getIssue(ada, x.ref)).issue;
    assert.equal(after.cycle, null);
    assert.equal(after.teamId, t.id, "team_id is left alone");
  });
});

describe("rollover", () => {
  // A fresh team: cycle 1 (Aug 3 to Aug 10) holds two open issues, one in a custom status, and one done; cycle 2 follows.
  const setup = async (key: string, withNext: boolean) => {
    const t = await createTeam(ada, { name: `Roll ${key}`, key });
    const start = at(-1);
    await cy.createCycle(ada, t.key, { startsAt: start, endsAt: new Date(start.getTime() + 7 * DAY) }, start);
    if (withNext) await cy.createCycle(ada, t.key, { startsAt: new Date(start.getTime() + 7 * DAY), endsAt: new Date(start.getTime() + 14 * DAY) }, start);
    const todo = await createIssue(ada, t.key, { title: "still todo", cycle: 1, status: "Todo" });
    const doing = await createIssue(ada, t.key, { title: "in progress", cycle: 1, status: "In Progress" });
    const done = await createIssue(ada, t.key, { title: "finished", cycle: 1, status: "Done" });
    const outside = await createIssue(ada, t.key, { title: "no cycle", status: "Todo" });
    return { t, start, todo, doing, done, outside };
  };

  test("when a cycle ends, exactly its unfinished issues move to the next cycle, once", async () => {
    const { t, start, todo, doing, done, outside } = await setup(`${L}E`, true);
    const during = new Date(start.getTime() + 3 * DAY);
    assert.deepEqual(await cy.rolloverCycles(t.id, during), { cycles: 0, moved: 0 }, "nothing happens while it runs");
    const after = new Date(start.getTime() + 8 * DAY);
    const first = await cy.rolloverCycles(t.id, after);
    assert.deepEqual(first, { cycles: 1, moved: 2 });
    assert.equal(await cycleOf(todo.ref), 2);
    assert.equal(await cycleOf(doing.ref), 2);
    assert.equal(await cycleOf(done.ref), 1, "a done issue stays in the cycle it finished in");
    assert.equal(await cycleOf(outside.ref), null);
    const [ev] = await db.select().from(schema.events).where(and(eq(schema.events.teamId, t.id), eq(schema.events.type, "cycle.rolled_over")));
    assert.deepEqual([ev.actorName, ev.entity, (ev.data as { moved: number; from: number; to: number }).moved, (ev.data as { from: number }).from, (ev.data as { to: number }).to], ["Wheelhouse", "cycle", 2, 1, 2]);
    assert.equal((await cycleRow(t, 1)).rolledOverAt?.getTime(), after.getTime());
  });

  test("it is idempotent: again, or from many requests at once, changes nothing, even if an issue came back", async () => {
    const { t, start, todo } = await setup(`${L}F`, true);
    const after = new Date(start.getTime() + 8 * DAY);
    const version = (await getIssue(ada, todo.ref)).issue.version;
    const runs = await Promise.all([1, 2, 3, 4].map(() => cy.rolloverCycles(t.id, after)));
    assert.equal(runs.reduce((n, r) => n + r.moved, 0), 2, "exactly the two open issues, once across all the runs");
    assert.equal((await getIssue(ada, todo.ref)).issue.version, version + 1, "a moved issue's version moves once");
    assert.deepEqual(await cy.rolloverCycles(t.id, after), { cycles: 0, moved: 0 });
    // Put an issue back in the cycle that has been rolled over: a second sweep does not take it out again (it happens once per cycle).
    await db.update(schema.issues).set({ cycleId: (await cycleRow(t, 1)).id }).where(eq(schema.issues.id, todo.id));
    assert.deepEqual(await cy.rolloverCycles(t.id, after), { cycles: 0, moved: 0 });
    assert.equal(await cycleOf(todo.ref), 1);
    assert.equal((await db.select().from(schema.events).where(and(eq(schema.events.teamId, t.id), eq(schema.events.type, "cycle.rolled_over")))).length, 1);
  });

  test("with no next cycle one is made of the same length, starting where the last ended", async () => {
    const { t, start, todo } = await setup(`${L}G`, false);
    const after = new Date(start.getTime() + 8 * DAY);
    assert.deepEqual(await cy.rolloverCycles(t.id, after), { cycles: 1, moved: 2 });
    const next = await cycleRow(t, 2);
    assert.deepEqual([next.startsAt.getTime(), next.endsAt.getTime()], [start.getTime() + 7 * DAY, start.getTime() + 14 * DAY]);
    assert.equal(await cycleOf(todo.ref), 2);
    const made = (await db.select().from(schema.events).where(and(eq(schema.events.teamId, t.id), eq(schema.events.type, "cycle.created")))).find((e) => e.actorName === "Wheelhouse");
    assert.ok(made, "the cycle it made is announced, as Wheelhouse");
    assert.equal((made.data as { after: number }).after, 1);
  });

  test("a team that was away for weeks gets a cycle that holds today, not a chain of empty ones", async () => {
    const { t, start, todo } = await setup(`${L}H`, false);
    const later = new Date(start.getTime() + 7 * DAY + 20 * DAY); // 20 days after cycle 1 ended
    await cy.rolloverCycles(t.id, later);
    const all = await db.select().from(schema.cycles).where(eq(schema.cycles.teamId, t.id));
    assert.equal(all.length, 2, "one new cycle, however long it was");
    const next = all.find((c) => c.number === 2)!;
    assert.ok(next.startsAt.getTime() <= later.getTime() && later.getTime() < next.endsAt.getTime(), "the new cycle is the one running at the time");
    assert.equal(await cycleOf(todo.ref), 2);
  });

  test("an ended cycle with nothing unfinished is marked done and nothing else happens", async () => {
    const t = await createTeam(ada, { name: "Quiet", key: `${L}Q` });
    const start = at(-1);
    await cy.createCycle(ada, t.key, { startsAt: start, endsAt: new Date(start.getTime() + 7 * DAY) }, start);
    await createIssue(ada, t.key, { title: "all done", cycle: 1, status: "Done" });
    assert.deepEqual(await cy.rolloverCycles(t.id, new Date(start.getTime() + 9 * DAY)), { cycles: 1, moved: 0 });
    assert.equal((await db.select().from(schema.cycles).where(eq(schema.cycles.teamId, t.id))).length, 1, "no cycle is made for nobody");
  });

  test("reading the cycles or the board does the rollover (the clock is the caller's)", async () => {
    const { t, start, todo } = await setup(`${L}I`, true);
    const after = new Date(start.getTime() + 8 * DAY);
    const list = await cy.listCycles(ada, t.key, after);
    assert.equal(list.current!.number, 2);
    assert.equal(list.current!.open, 2, "the two open issues are in the current cycle");
    assert.equal((list.past[0] as cy.CycleSummary).done, 1);
    assert.equal(await cycleOf(todo.ref), 2);
  });
});

describe("the cycle view and what landed", () => {
  /** Move an issue to Done, then say it happened at `at` (events take the database's clock; the test sets the day it means). */
  const finish = async (team: { key: string; id: string }, ref: string, at: Date) => {
    const t = await getIssue(ada, ref);
    await moveIssue(ada, ref, "Done");
    const moves = await db.select({ seq: schema.events.seq }).from(schema.events).where(and(eq(schema.events.entityId, t.issue.id), eq(schema.events.type, "issue.moved")));
    const latest = Math.max(...moves.map((m) => m.seq));
    await db.update(schema.events).set({ createdAt: at }).where(eq(schema.events.seq, latest));
    void team;
  };

  test("the report lists exactly the issues that reached Done inside the window, once each, oldest first", async () => {
    const t = await createTeam(ada, { name: "Landed", key: `${L}L` });
    const start = at(-1);
    const end = new Date(start.getTime() + 7 * DAY);
    await cy.createCycle(ada, t.key, { name: "Autumn", startsAt: start, endsAt: end }, start);
    const inside1 = await createIssue(ada, t.key, { title: "inside, in the cycle", cycle: 1 });
    const inside2 = await createIssue(ada, t.key, { title: "inside, not in the cycle" });
    const before = await createIssue(ada, t.key, { title: "done before", cycle: 1 });
    const after = await createIssue(ada, t.key, { title: "done after", cycle: 1 });
    const bounced = await createIssue(ada, t.key, { title: "done, reopened, done again", cycle: 1 });
    const open = await createIssue(ada, t.key, { title: "still open", cycle: 1 });
    await finish(t, before.ref, new Date(start.getTime() - 1000));
    await finish(t, inside2.ref, new Date(start.getTime() + 3 * DAY));
    await finish(t, inside1.ref, new Date(start.getTime() + 1 * DAY));
    await finish(t, after.ref, end); // the window is [start, end): the end itself is the next cycle's
    await finish(t, bounced.ref, new Date(start.getTime() + 2 * DAY));
    await moveIssue(ada, bounced.ref, "In Progress");
    await finish(t, bounced.ref, new Date(start.getTime() + 4 * DAY));

    const same = (v: cy.CycleDetail) => assert.deepEqual(v.landed.map((l) => l.ref), [inside1.ref, bounced.ref, inside2.ref], "inside the window only, by when they landed, a reopened issue once");
    // While it runs: five issues are in it, four are done, one is open.
    const mid = await cy.getCycle(ada, t.key, 1, new Date(end.getTime() - 3600_000));
    same(mid);
    assert.deepEqual([mid.total, mid.done, mid.open], [5, 4, 1]);
    assert.deepEqual(mid.issues.filter((x) => !x.done).map((x) => x.ref), [open.ref]);
    assert.deepEqual(mid.landed.map((l) => l.inCycle), [true, true, false], "and which of them were in the cycle");
    assert.equal(mid.landed.find((l) => l.ref === bounced.ref)!.doneAt.getTime(), start.getTime() + 2 * DAY, "at its first time in the window");
    assert.equal(mid.name, "Autumn");
    // Once it has ended the open issue has moved on, and the report is the same list (the window did not change).
    const over = await cy.getCycle(ada, t.key, 1, new Date(end.getTime() + DAY));
    same(over);
    assert.deepEqual([over.total, over.done, over.open], [4, 4, 0]);
    assert.equal(await cycleOf(open.ref), 2, "the open issue is in the next cycle");
  });

  test("a cycle that has not started has landed nothing; a running one reports up to now", async () => {
    const t = await createTeam(ada, { name: "Soon", key: `${L}S` });
    await cy.createCycle(ada, t.key, { startsAt: at(-1), endsAt: at(6) }, T0);
    await cy.createCycle(ada, t.key, { startsAt: at(6), endsAt: at(13) }, T0);
    const x = await createIssue(ada, t.key, { title: "x", cycle: 1 });
    await finish(t, x.ref, T0);
    assert.deepEqual((await cy.getCycle(ada, t.key, 1, new Date(T0.getTime() + 1000))).landed.map((l) => l.ref), [x.ref]);
    assert.deepEqual((await cy.getCycle(ada, t.key, 2, T0)).landed, [], "an upcoming cycle has landed nothing");
    assert.deepEqual((await cy.getCycle(ada, t.key, 1, at(-1))).landed, [], "asked at the moment it began, nothing had landed yet");
  });

  test("older events that only named the status still count, and a deleted issue is not listed", async () => {
    const t = await createTeam(ada, { name: "Old", key: `${L}T` });
    const start = at(-1);
    await cy.createCycle(ada, t.key, { startsAt: start, endsAt: new Date(start.getTime() + 7 * DAY) }, start);
    const x = await createIssue(ada, t.key, { title: "old style", cycle: 1 });
    const y = await createIssue(ada, t.key, { title: "will be deleted", cycle: 1 });
    await finish(t, x.ref, new Date(start.getTime() + DAY));
    await finish(t, y.ref, new Date(start.getTime() + DAY));
    const evX = (await db.select().from(schema.events).where(and(eq(schema.events.entityId, x.id), eq(schema.events.type, "issue.moved"))))[0];
    await db.update(schema.events).set({ data: { ref: x.ref, from: "Backlog", to: "Done" } }).where(eq(schema.events.seq, evX.seq));
    await deleteIssue(ada, y.ref);
    const view = await cy.getCycle(ada, t.key, 1, new Date(start.getTime() + 3 * DAY));
    assert.deepEqual(view.landed.map((l) => l.ref), [x.ref]);
  });
});
