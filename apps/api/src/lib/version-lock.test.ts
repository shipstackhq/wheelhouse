/**
 * Two edits made from the same version: exactly one is applied, the other is a conflict, and nothing is overwritten (issues, docs,
 * map nodes, flows, decisions). This only means something on a real Postgres, where two transactions really do run at once
 * (`TEST_DATABASE_URL=postgres://... --test-force-exit`, as in CI): on the embedded single-connection database they queue up and
 * the check passes whether or not the rows are locked. It once did not: both edits were applied and one silently replaced the other.
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
import type { Actor } from "../common/actor";
import { createDoc, moveDoc, updateDoc } from "../modules/docs/docs";
import { createIssue, getIssue, moveIssue, updateIssue } from "../modules/issues/issues";
import { upsertDecision } from "../modules/map/decisions";
import { upsertFlow, upsertNode } from "../modules/map/graph";
import { createTeam } from "../modules/teams/teams.legacy";
import { ServiceError } from "../common/service-error";
import { testApp } from "../test/app";
await testApp();

let actor: Actor;
const ROUNDS = 6;

before(async () => {
  const db = await getDb();
  const [workspace] = await db.insert(schema.workspaces).values({ name: "Lock workspace" }).returning();
  const [user] = await db.insert(schema.users).values({ email: `lock-${Math.random().toString(16).slice(2, 8)}@example.com`, name: "Lena", passwordHash: "x" }).returning();
  await db.insert(schema.memberships).values({ userId: user.id, workspaceId: workspace.id, role: "owner" });
  actor = { kind: "human", id: user.id, name: user.name, workspaceId: workspace.id };
  await createTeam(actor, { name: "Lock", key: "LK" });
});

/** Run both at once; report which were applied and which were refused as conflicts. */
async function race(a: () => Promise<unknown>, b: () => Promise<unknown>) {
  const settled = await Promise.allSettled([a(), b()]);
  const refused = settled.filter((s) => s.status === "rejected" && s.reason instanceof ServiceError && s.reason.code === "conflict").length;
  const applied = settled.filter((s) => s.status === "fulfilled").length;
  const other = settled.filter((s) => s.status === "rejected" && !(s.reason instanceof ServiceError && s.reason.code === "conflict"));
  assert.deepEqual(other.map((o) => (o as PromiseRejectedResult).reason), [], "no failure other than a conflict");
  return { applied, refused };
}

describe("two edits from the same version", () => {
  test("issues: one is applied, one is a conflict", async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const t = await createIssue(actor, "LK", { title: `t${i}` });
      const r = await race(() => updateIssue(actor, t.id, { title: "A" }, t.version), () => updateIssue(actor, t.id, { title: "B" }, t.version));
      assert.deepEqual(r, { applied: 1, refused: 1 }, `round ${i}`);
      assert.equal((await getIssue(actor, t.id)).issue.version, t.version + 1);
    }
  });

  test("moving an issue: one is applied, one is a conflict", async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const t = await createIssue(actor, "LK", { title: `m${i}` });
      const r = await race(() => moveIssue(actor, t.id, "In Progress", undefined, t.version), () => moveIssue(actor, t.id, "Review", undefined, t.version));
      assert.deepEqual(r, { applied: 1, refused: 1 }, `round ${i}`);
    }
  });

  test("docs: edit and move", async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const d = await createDoc(actor, "LK", { title: `d${i}`, body: "x" });
      const edit = await race(() => updateDoc(actor, "LK", d.id, { body: "A" }, d.version), () => updateDoc(actor, "LK", d.id, { body: "B" }, d.version));
      assert.deepEqual(edit, { applied: 1, refused: 1 }, `edit ${i}`);
      const e = await createDoc(actor, "LK", { title: `e${i}`, body: "x" });
      const f = await createDoc(actor, "LK", { title: `f${i}` });
      const move = await race(() => moveDoc(actor, "LK", e.id, { parent: f.id }, e.version), () => moveDoc(actor, "LK", e.id, { parent: null, index: 0 }, e.version));
      assert.deepEqual(move, { applied: 1, refused: 1 }, `move ${i}`);
    }
  });

  test("map nodes, flows and decisions", async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const n = await upsertNode(actor, "LK", { name: `Node ${i}`, layer: "system", summary: "s" });
      const node = await race(() => upsertNode(actor, "LK", { id: n.id, summary: "A", expectedVersion: n.version }), () => upsertNode(actor, "LK", { id: n.id, summary: "B", expectedVersion: n.version }));
      assert.deepEqual(node, { applied: 1, refused: 1 }, `node ${i}`);

      const f = await upsertFlow(actor, "LK", { name: `Flow ${i}`, steps: [{ node: n.id, title: "go" }] });
      const flow = await race(() => upsertFlow(actor, "LK", { id: f.id, name: `Flow ${i}`, description: "A", expectedVersion: f.version }), () => upsertFlow(actor, "LK", { id: f.id, name: `Flow ${i}`, description: "B", expectedVersion: f.version }));
      assert.deepEqual(flow, { applied: 1, refused: 1 }, `flow ${i}`);

      const d = await upsertDecision(actor, "LK", { title: `Decision ${i}` });
      const decision = await race(() => upsertDecision(actor, "LK", { number: d.number, context: "A", expectedVersion: d.version }), () => upsertDecision(actor, "LK", { number: d.number, context: "B", expectedVersion: d.version }));
      assert.deepEqual(decision, { applied: 1, refused: 1 }, `decision ${i}`);
    }
  });
});
