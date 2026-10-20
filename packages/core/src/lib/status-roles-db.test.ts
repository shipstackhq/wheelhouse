/**
 * Status roles against a real database (WH-86): a board can rename its statuses without breaking the logic that finds
 * "review" and "done". Runs on an in-memory PGlite (`pnpm test`), or a real Postgres with TEST_DATABASE_URL.
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
import { getDb, schema } from "../db";
import type { Actor } from "./access";
import { scopeKeyToAllTeams } from "./key-scope";
import * as svc from "./service";
import { summary } from "./metrics";
import { briefing } from "./briefing";

let human: Actor;
let agent: Actor;
let teamId: string;

const rename = async (from: string, to: string) => {
  const db = await getDb();
  await db.update(schema.statuses).set({ name: to }).where(and(eq(schema.statuses.teamId, teamId), eq(schema.statuses.name, from)));
};
const columnOf = async (ref: string) => (await svc.getIssue(human, ref)).issue.status;

before(async () => {
  const db = await getDb();
  const [workspace] = await db.insert(schema.workspaces).values({ name: "Roles workspace" }).returning();
  const [user] = await db.insert(schema.users).values({ email: `r-${Math.random().toString(16).slice(2, 8)}@example.com`, name: "Rae", passwordHash: "x" }).returning();
  await db.insert(schema.memberships).values({ userId: user.id, workspaceId: workspace.id, role: "owner" });
  const [k] = await db.insert(schema.apiKeys).values({ workspaceId: workspace.id, name: "worker", prefix: "wh_", keyHash: "worker" }).returning();
  human = { kind: "human", id: user.id, name: "Rae", workspaceId: workspace.id };
  agent = { kind: "agent", id: k.id, name: "worker", workspaceId: workspace.id };
  teamId = (await svc.createTeam(human, { name: "Roles", key: "RR" })).id;
  await scopeKeyToAllTeams(db, agent.id, workspace.id);
});

describe("status roles", () => {
  test("a new team's five statuses each have their role", async () => {
    const { statuses } = await svc.getBoard(human, "RR");
    assert.deepEqual(statuses.map((c) => [c.name, c.role]), [["Backlog", "backlog"], ["Todo", "todo"], ["In Progress", "in_progress"], ["Review", "review"], ["Done", "done"]]);
  });

  test("a renamed status is still found by its role, and an exact name still wins", async () => {
    await rename("Review", "QA");
    await rename("Done", "Shipped");
    const t = await svc.createIssue(human, "RR", { title: "Move me" });
    assert.equal((await svc.moveIssue(human, t.ref, "review")).status, "QA", "role finds the renamed review status");
    assert.equal((await svc.moveIssue(human, t.ref, "In progress")).status, "In Progress", "case-insensitive name");
    assert.equal((await svc.moveIssue(human, t.ref, "qa")).status, "QA", "the new name works");
    assert.equal((await svc.moveIssue(human, t.ref, "done")).status, "Shipped", "role finds the renamed done status");
    await assert.rejects(svc.moveIssue(human, t.ref, "nonsense"), (e: unknown) => e instanceof svc.ServiceError && e.code === "invalid");

    // A status that is literally called "review" but has no role beats the role alias on an exact name match.
    const db = await getDb();
    await db.insert(schema.statuses).values({ teamId, workspaceId: human.workspaceId, name: "review", position: 99, role: null });
    assert.equal((await svc.moveIssue(human, t.ref, "review")).status, "review");
    await db.delete(schema.statuses).where(and(eq(schema.statuses.teamId, teamId), eq(schema.statuses.name, "review")));
  });

  test("moves record the roles, so history survives a later rename", async () => {
    const t = await svc.createIssue(human, "RR", { title: "History" });
    await svc.moveIssue(human, t.ref, "review");
    const moved = (await svc.getIssue(human, t.ref)).history.find((e) => e.type === "issue.moved");
    assert.equal(moved?.data?.toRole, "review");
    assert.equal(moved?.data?.fromRole, "backlog");
  });

  test("the dashboard counts review and done by role after both were renamed", async () => {
    const before = await summary(human);
    const t = await svc.createIssue(human, "RR", { title: "Counted" });
    await svc.moveIssue(human, t.ref, "review");
    const mid = await summary(human);
    assert.equal(mid.inReview, before.inReview + 1, "waiting for review counts the QA status");
    await svc.moveIssue(human, t.ref, "done");
    const end = await summary(human);
    assert.equal(end.inReview, before.inReview, "no longer waiting");
    assert.equal(end.open, before.open, "an issue in the renamed done status is not open");
    assert.equal(end.completed7d, before.completed7d + 1, "the move into the renamed done status is a completion");
  });

  test("the briefing reports review and in progress by role", async () => {
    const t = await svc.createIssue(human, "RR", { title: "Reviewable" });
    await svc.moveIssue(human, t.ref, "review");
    const { markdown } = await briefing(agent, "RR");
    assert.match(markdown, /Waiting for review: \d+/);
    const d = await svc.createIssue(human, "RR", { title: "Finished" });
    await svc.moveIssue(human, d.ref, "done");
    assert.ok(!markdown.includes("Finished"), "an issue in the renamed done status is not listed as open work");
    assert.equal(await columnOf(d.ref), "Shipped");
  });
});
