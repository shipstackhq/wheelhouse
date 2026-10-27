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
  test("reading another workspace's team, board, issue and changes is not_found", async () => {
    const attempts: [string, Record<string, unknown>][] = [
      ["list_issues", { team: fx.a.teamKey }],
      ["get_issue", { ref: fx.a.issueRef }],
      ["get_changes", { team: fx.a.teamKey }],
      ["get_map", { team: fx.a.teamKey }],
      ["get_briefing", { team: fx.a.teamKey }],
    ];
    for (const [tool, args] of attempts) {
      const r = await v1(B, tool, args);
      assert.equal(r.status, 404, tool);
      assert.equal(r.json.error.code, "not_found", tool);
    }
  });

  test("an issue id (uuid) from another workspace is no more reachable than its ref", async () => {
    const id = (await v1ok(A, "get_issue", { ref: fx.a.issueRef })).issue.id;
    assert.equal((await v1(B, "get_issue", { ref: id })).status, 404);
  });

  test("writing to another workspace's team or issue is refused and changes nothing", async () => {
    const before = (await v1ok(A, "get_issue", { ref: fx.a.issueRef })).issue;
    const writes: [string, Record<string, unknown>][] = [
      ["create_issue", { team: fx.a.teamKey, title: "intruder" }],
      ["update_issue", { ref: fx.a.issueRef, title: "hijacked" }],
      ["update_issue", { ref: fx.a.issueRef, status: "Done" }],
      ["comment", { ref: fx.a.issueRef, body: "intruder" }],
      ["update_issue", { ref: fx.a.issueRef, assignee: "me" }],
      ["update_map", { team: fx.a.teamKey, changes: [{ op: "upsert_node", name: "intruder node" }] }],
    ];
    for (const [tool, args] of writes) {
      const r = await v1(B, tool, args);
      assert.equal(r.status, 404, tool);
    }
    const after = (await v1ok(A, "get_issue", { ref: fx.a.issueRef })).issue;
    assert.equal(after.title, before.title);
    assert.equal(after.version, before.version);
    assert.equal(after.status, before.status);
  });

  test("a workspace's team list holds only its own teams", async () => {
    const a = (await v1ok(A, "get_briefing")).teams.map((p: { key: string }) => p.key);
    const b = (await v1ok(B, "get_briefing")).teams.map((p: { key: string }) => p.key);
    assert.deepEqual(a, [fx.a.teamKey]);
    assert.deepEqual(b, [fx.b.teamKey]);
  });
});
