import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { asKey, fx, v1, v1ok } from "./lib/http";

/**
 * Cross-workspace isolation seen from outside (WH-50): one workspace's key can neither read nor change another workspace's data, and the
 * failure looks exactly like the data not existing.
 */
const A = asKey(fx.a.apiKey);
const B = asKey(fx.b.apiKey);

describe("one workspace cannot reach another's data over HTTP", () => {
  test("reading another workspace's team, board, issue, changes and activity is not_found", async () => {
    const attempts: [string, Record<string, unknown>][] = [
      ["get_board", { project: fx.a.teamKey }],
      ["get_issue", { issue: fx.a.issueRef }],
      ["get_changes", { project: fx.a.teamKey }],
      ["get_activity", { project: fx.a.teamKey }],
      ["get_graph", { project: fx.a.teamKey }],
      ["get_briefing", { project: fx.a.teamKey }],
    ];
    for (const [tool, args] of attempts) {
      const r = await v1(B, tool, args);
      assert.equal(r.status, 404, tool);
      assert.equal(r.json.error.code, "not_found", tool);
    }
  });

  test("an issue id (uuid) from another workspace is no more reachable than its ref", async () => {
    const id = (await v1ok(A, "get_issue", { issue: fx.a.issueRef })).issue.id;
    assert.equal((await v1(B, "get_issue", { issue: id })).status, 404);
  });

  test("writing to another workspace's team or issue is refused and changes nothing", async () => {
    const before = (await v1ok(A, "get_issue", { issue: fx.a.issueRef })).issue;
    const writes: [string, Record<string, unknown>][] = [
      ["create_issue", { project: fx.a.teamKey, title: "intruder" }],
      ["update_issue", { issue: fx.a.issueRef, title: "hijacked" }],
      ["move_issue", { issue: fx.a.issueRef, status: "Done" }],
      ["comment", { issue: fx.a.issueRef, body: "intruder" }],
      ["claim_issue", { issue: fx.a.issueRef }],
      ["upsert_node", { project: fx.a.teamKey, name: "intruder node" }],
    ];
    for (const [tool, args] of writes) {
      const r = await v1(B, tool, args);
      assert.equal(r.status, 404, tool);
    }
    const after = (await v1ok(A, "get_issue", { issue: fx.a.issueRef })).issue;
    assert.equal(after.title, before.title);
    assert.equal(after.version, before.version);
    assert.equal(after.statusId, before.statusId);
  });

  test("a workspace's team list holds only its own teams", async () => {
    const a = (await v1ok(A, "list_projects")).map((p: { key: string }) => p.key);
    const b = (await v1ok(B, "list_projects")).map((p: { key: string }) => p.key);
    assert.deepEqual(a, [fx.a.teamKey]);
    assert.deepEqual(b, [fx.b.teamKey]);
  });
});
