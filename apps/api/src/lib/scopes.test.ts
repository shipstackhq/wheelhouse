import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Actor } from "../common/actor";
import { runMcp } from "./mcp";
import { listToolDefs, tools } from "./tools";

const agent = (scopes: string[]): Actor => ({ kind: "agent", id: "k", name: "k", workspaceId: "w", scopes });
const human: Actor = { kind: "human", id: "u", name: "u", workspaceId: "w" };
const names = (actor: Actor) => listToolDefs({ actor }).map((t) => t.name);

describe("key scopes", () => {
  test("tools/list shows an agent only the tools its scopes allow; people see every tool", () => {
    const read = names(agent(["read"]));
    assert.ok(read.includes("list_issues") && !read.includes("create_issue") && !read.includes("update_map") && !read.includes("write_doc") && !read.includes("plan"));
    const board = names(agent(["read", "board:write"]));
    assert.ok(board.includes("create_issue") && !board.includes("update_map"));
    assert.ok(names(agent(["docs:write"])).every((n) => tools[n as keyof typeof tools].scope === "docs:write"));
    assert.equal(names(human).length, listToolDefs().length);
  });

  test("tools/call refuses a tool whose scope the key lacks, naming the scope", async () => {
    const call = (actor: Actor) => runMcp(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "write_doc", arguments: {} } }), async () => actor);
    const r = (await call(agent(["read", "board:write", "map:write"]))).body as { result: { isError: boolean; content: { text: string }[] } };
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /^forbidden: .*"docs:write"/);
  });
});
