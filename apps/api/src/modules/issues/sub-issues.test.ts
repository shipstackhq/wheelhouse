/**
 * Sub-issues against a real database: an issue sits under another of its own team, a loop is refused however indirect, and deleting a
 * parent frees its children. Runs on an in-memory PGlite (`pnpm test`), or a real Postgres with TEST_DATABASE_URL.
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
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { createTeam } from "../teams/teams.legacy";
import { createIssue, deleteIssue, getIssue, moveIssue, updateIssue } from "./issues";
import { issueDetail, issueInput } from "./board-app";
import { MAX_ISSUE_DEPTH } from "./sub-issues";
import { testApp } from "../../test/app";
await testApp();

let human: Actor;
const refused = (e: unknown) => e instanceof ServiceError && e.code === "invalid";

before(async () => {
  const db = await getDb();
  const [workspace] = await db.insert(schema.workspaces).values({ name: "Sub-issues workspace" }).returning();
  const [user] = await db.insert(schema.users).values({ email: `s-${Math.random().toString(16).slice(2, 8)}@example.com`, name: "Sam", passwordHash: "x" }).returning();
  await db.insert(schema.memberships).values({ userId: user.id, workspaceId: workspace.id, role: "owner" });
  human = { kind: "human", id: user.id, name: "Sam", workspaceId: workspace.id };
  await createTeam(human, { name: "Alpha", key: "SA" });
  await createTeam(human, { name: "Beta", key: "SB" });
});

describe("sub-issues", () => {
  test("an issue is created under another by its ref, and it and its parent say so", async () => {
    const parent = await createIssue(human, "SA", { title: "parent" });
    const child = await createIssue(human, "SA", { title: "child", parent: parent.ref });
    assert.equal(child.parentId, parent.id);
    const p = await getIssue(human, parent.ref);
    assert.deepEqual(p.children.map((c) => [c.ref, c.title, c.status, c.done, c.canceled]), [[child.ref, "child", "Backlog", false, false]]);
    assert.equal(p.parent, null);
    const c = await getIssue(human, child.ref);
    assert.equal(c.parent?.ref, parent.ref);
    assert.deepEqual(c.children, []);
    assert.equal(c.issue.parentId, parent.id);
  });

  test("the parent can be an id, and a ref is read in any case", async () => {
    const parent = await createIssue(human, "SA", { title: "by id" });
    const a = await createIssue(human, "SA", { title: "a", parent: parent.id });
    const b = await createIssue(human, "SA", { title: "b", parent: parent.ref.toLowerCase() });
    assert.equal(a.parentId, parent.id);
    assert.equal(b.parentId, parent.id);
  });

  test("an issue is moved under another, and out again with null; changing nothing changes nothing", async () => {
    const x = await createIssue(human, "SA", { title: "x" });
    const y = await createIssue(human, "SA", { title: "y" });
    const moved = await updateIssue(human, y.ref, { parent: x.ref });
    assert.equal(moved.parentId, x.id);
    assert.equal(moved.version, y.version + 1);
    const same = await updateIssue(human, y.ref, { parent: x.ref });
    assert.equal(same.version, moved.version, "the same parent again is no change");
    const freed = await updateIssue(human, y.ref, { parent: null });
    assert.equal(freed.parentId, null);
    assert.deepEqual((await getIssue(human, x.ref)).children, []);
  });

  test("a parent is in the same team", async () => {
    const other = await createIssue(human, "SB", { title: "other team" });
    const mine = await createIssue(human, "SA", { title: "mine" });
    await assert.rejects(createIssue(human, "SA", { title: "c", parent: other.ref }), refused);
    await assert.rejects(createIssue(human, "SA", { title: "c", parent: other.id }), refused);
    await assert.rejects(updateIssue(human, mine.ref, { parent: other.ref }), refused);
    await assert.rejects(updateIssue(human, mine.ref, { parent: "SA-99999" }), refused, "an issue that does not exist");
    await assert.rejects(updateIssue(human, mine.ref, { parent: "nonsense" }), refused);
  });

  test("an issue cannot be its own parent, or under its own descendant at any depth", async () => {
    const a = await createIssue(human, "SA", { title: "a" });
    const b = await createIssue(human, "SA", { title: "b", parent: a.ref });
    const c = await createIssue(human, "SA", { title: "c", parent: b.ref });
    const d = await createIssue(human, "SA", { title: "d", parent: c.ref });
    await assert.rejects(updateIssue(human, a.ref, { parent: a.ref }), refused, "itself");
    await assert.rejects(updateIssue(human, a.ref, { parent: b.ref }), refused, "its child");
    await assert.rejects(updateIssue(human, a.ref, { parent: d.ref }), refused, "its great-grandchild");
    await assert.rejects(updateIssue(human, b.ref, { parent: d.ref }), refused, "a descendant in the middle of the chain");
    // nothing changed, and a legal move in the same tree still works: d under a is fine, it only shortens the chain
    assert.equal((await getIssue(human, a.ref)).issue.parentId, null);
    assert.equal((await updateIssue(human, d.ref, { parent: a.ref })).parentId, a.id);
  });

  test("a chain can be as deep as the limit and no deeper", async () => {
    let parent: string | undefined;
    let last: { ref: string } | undefined;
    for (let i = 0; i < MAX_ISSUE_DEPTH; i++) {
      last = await createIssue(human, "SA", { title: `level ${i + 1}`, parent });
      parent = last.ref;
    }
    await assert.rejects(createIssue(human, "SA", { title: "one too deep", parent: last!.ref }), (e: unknown) => refused(e) && /at most 50 levels/.test((e as Error).message));
    // moving a whole subtree under something deep counts the subtree's own depth too
    const lone = await createIssue(human, "SA", { title: "has a child" });
    await createIssue(human, "SA", { title: "its child", parent: lone.ref });
    await assert.rejects(updateIssue(human, lone.ref, { parent: last!.ref }), refused);
  });

  test("deleting a parent frees its sub-issues; they stay in their team", async () => {
    const db = await getDb();
    const parent = await createIssue(human, "SA", { title: "to delete" });
    const kid = await createIssue(human, "SA", { title: "survivor", parent: parent.ref });
    await deleteIssue(human, parent.ref);
    const [row] = await db.select().from(schema.issues).where(eq(schema.issues.id, kid.id));
    assert.equal(row.parentId, null);
    assert.equal(row.teamId, kid.teamId);
  });

  test("the database itself refuses an issue that is its own parent, or under an issue of another team", async () => {
    const db = await getDb();
    const a = await createIssue(human, "SA", { title: "guard a" });
    const b = await createIssue(human, "SB", { title: "guard b" });
    const code = (c: string) => (e: unknown) => (e as { cause?: { code?: string } }).cause?.code === c;
    await assert.rejects(db.update(schema.issues).set({ parentId: a.id }).where(eq(schema.issues.id, a.id)), code("23514"));
    await assert.rejects(db.update(schema.issues).set({ parentId: b.id }).where(eq(schema.issues.id, a.id)), code("23503"));
  });

  test("a request carries `parent` as a ref or null, and nothing else", () => {
    assert.equal(issueInput({ parent: " SA-3 " }, { create: false }).parent, "SA-3");
    assert.equal(issueInput({ parent: null }, { create: false }).parent, null);
    assert.equal("parent" in issueInput({ title: "t" }, { create: true }), false);
    for (const bad of [3, "", "  ", {}, []]) assert.throws(() => issueInput({ parent: bad }, { create: false }), /parent/, JSON.stringify(bad));
  });

  test("the issue dialog's detail has the parent and the children, with whether each is done or canceled", async () => {
    const parent = await createIssue(human, "SA", { title: "with progress" });
    const open = await createIssue(human, "SA", { title: "open", parent: parent.ref });
    const done = await createIssue(human, "SA", { title: "done", parent: parent.ref });
    const dropped = await createIssue(human, "SA", { title: "dropped", parent: parent.ref });
    await moveIssue(human, done.ref, "done");
    await moveIssue(human, dropped.ref, "canceled");
    const d = await issueDetail(human, parent.ref);
    assert.deepEqual(d.children.map((c) => [c.ref, c.status, c.done, c.canceled]), [[open.ref, "Backlog", false, false], [done.ref, "Done", true, false], [dropped.ref, "Canceled", false, true]]);
    assert.equal((await issueDetail(human, open.ref)).parent?.ref, parent.ref);
  });

  test("creating and re-parenting are in the issue's history", async () => {
    const parent = await createIssue(human, "SA", { title: "logged parent" });
    const child = await createIssue(human, "SA", { title: "logged child", parent: parent.ref });
    const detail = await getIssue(human, child.ref);
    assert.deepEqual(detail.history.find((e) => e.type === "issue.created")?.data, { ref: child.ref, status: "Backlog", title: "logged child", parent: parent.ref });
    const other = await createIssue(human, "SA", { title: "elsewhere" });
    await updateIssue(human, child.ref, { parent: other.ref });
    const updated = (await getIssue(human, child.ref)).history.find((e) => e.type === "issue.updated");
    assert.match(updated!.summary, /parentId/);
  });
});
