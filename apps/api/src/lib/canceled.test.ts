/**
 * A canceled issue is closed work that never happened: out of every total, never open, never handed on to the next cycle, and no
 * pull request moves it. Runs on an in-memory PGlite (`pnpm test`), or a real Postgres with TEST_DATABASE_URL.
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  process.env.PGLITE_DIR = "memory://";
  delete process.env.DATABASE_URL;
}

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { getDb, schema } from "../db";
import type { Actor } from "./access";
import * as svc from "./service";
import * as cy from "../modules/issues/cycles";
import * as pr from "../modules/issues/projects";
import { summary, teamProgress, needsAttention } from "./metrics";
import { briefing } from "../modules/map/briefing";
import { decideMove } from "./github/pr-rules";
import { DEFAULT_STATUS_DEFS } from "@wheelhouse/shared/status-roles";

let ada: Actor;
const DAY = 86_400_000;
const T0 = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
const at = (days: number) => new Date(T0.getTime() + days * DAY);

before(async () => {
  const db = await getDb();
  const [w] = await db.insert(schema.workspaces).values({ name: "Canceled workspace" }).returning();
  const [u] = await db.insert(schema.users).values({ email: `c-${Math.random().toString(16).slice(2, 8)}@example.com`, name: "Cass", passwordHash: "x" }).returning();
  await db.insert(schema.memberships).values({ userId: u.id, workspaceId: w.id, role: "owner" });
  ada = { kind: "human", id: u.id, name: "Cass", workspaceId: w.id };
  await svc.createTeam(ada, { name: "Gamma", key: "CX" });
});

describe("a canceled issue", () => {
  test("is out of a cycle's counts and is not handed on when the cycle ends", async () => {
    const first = await cy.createCycle(ada, "CX", { startsAt: at(-1), endsAt: at(6) }, T0);
    const second = await cy.createCycle(ada, "CX", { startsAt: at(6), endsAt: at(13) }, T0);
    const todo = await svc.createIssue(ada, "CX", { title: "still to do", cycle: first.number });
    const done = await svc.createIssue(ada, "CX", { title: "finished", cycle: first.number });
    const dropped = await svc.createIssue(ada, "CX", { title: "dropped", cycle: first.number });
    await svc.moveIssue(ada, done.ref, "done");
    await svc.moveIssue(ada, dropped.ref, "canceled");

    const during = (await cy.listCycles(ada, "CX", T0)).current!;
    assert.equal(during.number, first.number);
    assert.deepEqual([during.total, during.done, during.open], [2, 1, 1], "canceled is not counted at all");

    const { moved } = await cy.rolloverCycles((await svc.requireTeam(ada, "CX", "read")).id, at(8));
    assert.equal(moved, 1, "only the unfinished issue moves on");
    assert.equal((await svc.getIssue(ada, todo.ref)).issue.cycle, second.number);
    assert.equal((await svc.getIssue(ada, done.ref)).issue.cycle, first.number);
    assert.equal((await svc.getIssue(ada, dropped.ref)).issue.cycle, first.number, "a canceled issue stays where it was");
  });

  test("is out of a project's total, and a team's progress, and is not open work", async () => {
    const p = await pr.createProject(ada, { name: "Counted", leadTeam: "CX" });
    const mk = async (title: string, status: string) => {
      const t = await svc.createIssue(ada, "CX", { title, status, priority: "urgent" });
      await svc.updateIssue(ada, t.ref, { projectId: p.id });
      return t;
    };
    await mk("project done", "done");
    await mk("project open", "todo");
    await mk("project dropped", "canceled");
    const project = await pr.getProject(ada, p.id);
    assert.deepEqual([project.total, project.done], [2, 1]);

    const [team] = await teamProgress(ada);
    const scope = team.total;
    assert.ok(scope > 0);
    const before = await summary(ada);
    const dropped = await svc.createIssue(ada, "CX", { title: "newly dropped", status: "canceled", priority: "urgent" });
    const after = await summary(ada);
    assert.equal(after.open, before.open, "creating a canceled issue adds no open work");
    assert.equal((await teamProgress(ada))[0].total, scope, "nor does it change the team's total");
    assert.ok(!(await needsAttention(ada)).urgent.some((u) => u.ref === dropped.ref), "an urgent canceled issue needs no attention");
    const brief = await briefing(ada, "CX");
    assert.ok(!brief.markdown.includes(dropped.ref), "and the briefing does not list it");
  });

  test("is never moved by a pull request", () => {
    const board = DEFAULT_STATUS_DEFS.map((s) => ({ name: s.name, role: s.role }));
    const canceled = board.find((s) => s.role === "canceled")!;
    for (const action of ["opened", "reopened", "ready_for_review"]) {
      assert.equal(decideMove({ action, merged: false, draft: false, status: canceled, statuses: board, now: T0, lastMove: null }).move, null, action);
    }
    assert.equal(decideMove({ action: "closed", merged: true, draft: false, status: canceled, statuses: board, now: T0, lastMove: null }).move, null);
  });
});
