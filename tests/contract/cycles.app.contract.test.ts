import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { v1ok } from "./lib/http";
import { anon, app, newAccount, type Sess } from "./lib/app";

/**
 * A team's cycles (WH-117): the endpoints, what the board and an issue say about them, and what an agent on /api/v1 does and does
 * not see. Windows are set from the real clock (the server's), a number of days either side of now.
 */

const DAY = 86_400_000;
const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();

async function team(name = "Cycles") {
  const owner = await newAccount(name);
  await app("POST", "/api/app/teams", owner.sess, { body: { name: `${name} team`, key: "CYC" } });
  const key = (await app("POST", "/api/app/keys", owner.sess, { body: { name: "agent" } })).json.secret as string;
  return { owner, key, s: owner.sess };
}

type Summary = { number: number; name: string; goal: string; startsAt: string; endsAt: string; state: string; total: number; done: number; open: number };
const list = (s: Sess) => app("GET", "/api/app/teams/CYC/cycles", s);
const make = async (s: Sess, body: Record<string, unknown> = {}) => {
  const r = await app("POST", "/api/app/teams/CYC/cycles", s, { body });
  assert.equal(r.status, 201, r.text);
  return r.json.cycle as Summary;
};
const issue = async (s: Sess, body: Record<string, unknown>) => {
  const r = await app("POST", "/api/app/teams/CYC/issues", s, { body });
  assert.equal(r.status, 201, r.text);
  return r.json.issue as { ref: string; cycle: number | null };
};

describe("the cycles endpoints", () => {
  test("signed out is a 401, and a forged request is refused", async () => {
    assert.equal((await app("GET", "/api/app/teams/CYC/cycles", anon())).status, 401);
    const t = await team();
    assert.equal((await app("POST", "/api/app/teams/CYC/cycles", t.s, { body: {}, origin: "https://evil.example" })).status, 403);
    assert.equal((await app("POST", "/api/app/teams/CYC/cycles", t.s, { body: {}, csrf: null })).status, 403);
    assert.deepEqual((await list(t.s)).json, { current: null, upcoming: [], past: [] });
  });

  test("a cycle starts now for two weeks when nothing is said, and is the current one with its counts", async () => {
    const t = await team();
    const c = await make(t.s, { name: "First", goal: "Get going" });
    assert.deepEqual([c.number, c.name, c.goal, c.state, c.total, c.done, c.open], [1, "First", "Get going", "current", 0, 0, 0]);
    assert.equal(new Date(c.endsAt).getTime() - new Date(c.startsAt).getTime(), 14 * DAY);
    const l = (await list(t.s)).json as { current: Summary | null; upcoming: Summary[]; past: Summary[] };
    assert.equal(l.current!.number, 1);
    assert.deepEqual([l.upcoming.length, l.past.length], [0, 0]);
  });

  test("an upcoming cycle follows the current one; touching is allowed, overlapping is a 409 naming the other", async () => {
    const t = await team();
    const one = await make(t.s, { startsAt: at(-1), endsAt: at(6) });
    const two = await make(t.s, { startsAt: one.endsAt, endsAt: at(13) });
    assert.deepEqual([two.number, two.state], [2, "upcoming"]);
    const clash = await app("POST", "/api/app/teams/CYC/cycles", t.s, { body: { startsAt: at(5), endsAt: at(9) } });
    assert.equal(clash.status, 409);
    assert.match(clash.json.error.message, /overlaps Cycle \d/);
    assert.equal(clash.json.error.code, "conflict");
    const l = (await list(t.s)).json as { upcoming: Summary[] };
    assert.deepEqual(l.upcoming.map((c) => c.number), [2]);
  });

  test("a bad window is a 400 that names the field", async () => {
    const t = await team();
    for (const [body, field, message] of [
      [{ startsAt: at(2), endsAt: at(1) }, "endsAt", /after it starts/],
      [{ startsAt: at(0), endsAt: at(0.5) }, "endsAt", /at least one day/],
      [{ startsAt: at(0), endsAt: at(20) }, "endsAt", /at most two weeks/],
      [{ startsAt: "tomorrow-ish" }, "startsAt", /must be a date/],
      [{ name: 5 }, "name", /must be text/],
      [{ goal: "x".repeat(501) }, "goal", /at most 500/],
    ] as const) {
      const r = await app("POST", "/api/app/teams/CYC/cycles", t.s, { body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.json.error.details.fields[field], message);
    }
    assert.equal((await app("POST", "/api/app/teams/CYC/cycles", t.s, { body: [] as never })).status, 400, "a body that is not an object");
  });

  test("an issue joins a cycle from the issue's own endpoint, the answer and the board say which, and the filter list has it", async () => {
    const t = await team();
    await make(t.s, { name: "Spring" });
    const tk = await issue(t.s, { title: "In the cycle", cycle: 1 });
    assert.equal(tk.cycle, 1);
    const free = await issue(t.s, { title: "Free" });
    assert.equal(free.cycle, null);
    const moved = await app("PATCH", `/api/app/issues/${free.ref}`, t.s, { body: { cycle: 1 } });
    assert.equal(moved.status, 200, moved.text);
    assert.equal(moved.json.issue.cycle, 1);
    const board = (await app("GET", "/api/app/teams/CYC/board", t.s)).json;
    assert.deepEqual(board.issues.map((x: { cycle: number }) => x.cycle), [1, 1]);
    assert.deepEqual(board.cycles.map((c: { number: number; name: string; state: string }) => [c.number, c.name, c.state]), [[1, "Spring", "current"]]);
    const bad = await app("PATCH", `/api/app/issues/${free.ref}`, t.s, { body: { cycle: 9 } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error.details.fields.cycle, /no cycle 9/);
    assert.equal((await app("PATCH", `/api/app/issues/${free.ref}`, t.s, { body: { cycle: "one" } })).status, 400);
    assert.equal((await app("PATCH", `/api/app/issues/${free.ref}`, t.s, { body: { cycle: null } })).json.issue.cycle, null);
  });

  test("one cycle: its issues with their state, and what landed while it ran", async () => {
    const t = await team();
    await make(t.s, { startsAt: at(-1), endsAt: at(6) });
    const a = await issue(t.s, { title: "Will finish", cycle: 1 });
    await issue(t.s, { title: "Stays open", cycle: 1 });
    const out = await app("POST", `/api/app/issues/${a.ref}/move`, t.s, { body: { column: "done" } });
    assert.equal(out.status, 200, out.text);
    const r = await app("GET", "/api/app/teams/CYC/cycles/1", t.s);
    assert.equal(r.status, 200, r.text);
    const c = r.json.cycle as Summary & { issues: { ref: string; done: boolean }[]; landed: { ref: string; inCycle: boolean }[] };
    assert.deepEqual([c.total, c.done, c.open], [2, 1, 1]);
    assert.deepEqual(c.issues.map((x) => [x.ref, x.done]), [[a.ref, true], [`CYC-2`, false]]);
    assert.deepEqual(c.landed.map((x) => [x.ref, x.inCycle]), [[a.ref, true]]);
  });

  test("changing a cycle: name, goal and an open window; an unknown or odd number is a 404; deleting releases its issues", async () => {
    const t = await team();
    await make(t.s, { startsAt: at(-1), endsAt: at(6) });
    const tk = await issue(t.s, { title: "Inside", cycle: 1 });
    const p = await app("PATCH", "/api/app/teams/CYC/cycles/1", t.s, { body: { name: "Renamed", goal: "New goal", endsAt: at(10) } });
    assert.equal(p.status, 200, p.text);
    assert.deepEqual([p.json.cycle.name, p.json.cycle.goal], ["Renamed", "New goal"]);
    for (const n of ["2", "0", "-1", "abc", "1.5"]) assert.equal((await app("GET", `/api/app/teams/CYC/cycles/${n}`, t.s)).status, 404, n);
    assert.equal((await app("PATCH", "/api/app/teams/CYC/cycles/7", t.s, { body: { goal: "x" } })).status, 404);
    const d = await app("DELETE", "/api/app/teams/CYC/cycles/1", t.s);
    assert.equal(d.status, 200, d.text);
    assert.deepEqual([d.json.ok, d.json.released], [true, 1]);
    assert.equal((await app("GET", `/api/app/issues/${tk.ref}`, t.s)).json.issue.cycle, null);
    assert.equal((await app("DELETE", "/api/app/teams/CYC/cycles/1", t.s)).status, 404, "gone");
  });

  test("another workspace's team is a 404 for every cycle endpoint", async () => {
    const mine = await team("Mine");
    await make(mine.s);
    const other = await newAccount("Other");
    for (const [method, path, body] of [
      ["GET", "/api/app/teams/CYC/cycles", undefined],
      ["POST", "/api/app/teams/CYC/cycles", {}],
      ["GET", "/api/app/teams/CYC/cycles/1", undefined],
      ["PATCH", "/api/app/teams/CYC/cycles/1", { goal: "x" }],
      ["DELETE", "/api/app/teams/CYC/cycles/1", undefined],
    ] as const) {
      const r = await app(method, path, other.sess, body ? { body } : {});
      assert.equal(r.status, 404, `${method} ${path}`);
    }
    assert.equal(((await list(mine.s)).json as { current: Summary }).current.goal, "", "and nothing of mine changed");
  });

  test("agents hear cycle changes in their queue, and the old /api/v1 shapes do not grow a cycle", async () => {
    const t = await team();
    await make(t.s, { name: "Heard", startsAt: at(-1), endsAt: at(6) });
    const tk = await issue(t.s, { title: "For the agent", cycle: 1 });
    const changes = await v1ok({ key: t.key }, "get_changes", { project: "CYC" });
    const types = (changes.changes as { type: string; entity: string }[]).map((c) => `${c.type}/${c.entity}`);
    assert.ok(types.includes("cycle.created/cycle"), types.join(", "));
    const board = await v1ok({ key: t.key }, "get_board", { project: "CYC" });
    const first = board.columns.flatMap((c: { issues: object[] }) => c.issues)[0] as Record<string, unknown>;
    assert.ok(first, "the issue is on the agent's board");
    assert.equal("cycle" in first || "cycleId" in first, false);
    const got = await v1ok({ key: t.key }, "get_issue", { issue: tk.ref });
    assert.equal("cycle" in got.issue || "cycleId" in got.issue, false);
  });
});
