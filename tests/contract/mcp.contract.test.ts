import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { asCookie, asKey, call, fx, mcp, mcpToolResult } from "./lib/http";
import { expectGolden } from "./lib/golden";

const A = asKey(fx.a.apiKey);

describe("POST /mcp: authentication", () => {
  test("no credentials: 401 with a Bearer challenge and a JSON-RPC error", async () => {
    const r = await mcp({}, "tools/list");
    assert.equal(r.status, 401);
    assert.equal(r.headers.get("www-authenticate"), 'Bearer realm="wheelhouse"');
    assert.deepEqual(r.json, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Not authenticated" } });
  });

  test("an unknown or revoked key is refused", async () => {
    for (const key of ["wh_not_a_real_key", fx.a.revokedKey]) {
      const r = await mcp(asKey(key), "tools/list");
      assert.equal(r.status, 401, key);
      assert.equal(r.json.error.message, "Invalid or revoked API key");
    }
  });

  test("a suspended workspace's key gets 403, not 401, so clients stop retrying", async () => {
    const r = await mcp(asKey(fx.suspended.apiKey), "tools/list");
    assert.equal(r.status, 403);
    assert.equal(r.json.error.message, "This workspace has been suspended. Contact the administrator.");
  });

  test("repeated bad keys from one address are rate limited with Retry-After", async () => {
    const ip = "203.0.113.77";
    let limited;
    for (let i = 0; i < 40 && !limited; i++) {
      const r = await call("/mcp", { key: `wh_bad_${i}`, ip, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
      if (r.status === 429) limited = r;
      else assert.equal(r.status, 401);
    }
    assert.ok(limited, "never rate limited");
    assert.match(limited.headers.get("retry-after") ?? "", /^\d+$/);
    assert.equal(limited.json.error.message, "Too many requests");
  });

  test("a signed-in person (session cookie) can use it too", async () => {
    const r = await mcp(asCookie(fx.a.sessionToken), "tools/call", { name: "list_projects", arguments: {} });
    assert.equal(r.status, 200);
    assert.ok(mcpToolResult(r).some((p: { key: string }) => p.key === fx.a.teamKey));
  });
});

describe("POST /mcp: protocol", () => {
  test("initialize: server info, capabilities and agent instructions", async () => {
    const r = await mcp(A, "initialize", { protocolVersion: "2025-06-18" });
    assert.equal(r.status, 200);
    const { instructions, ...rest } = r.json.result;
    assert.match(instructions, /get_briefing/);
    assert.match(instructions, /get_changes/);
    expectGolden("mcp-initialize", { jsonrpc: r.json.jsonrpc, id: r.json.id, result: rest });
  });

  test("protocol versions: a supported one is echoed, an unknown one gets the newest we speak", async () => {
    assert.equal((await mcp(A, "initialize", { protocolVersion: "2024-11-05" })).json.result.protocolVersion, "2024-11-05");
    assert.equal((await mcp(A, "initialize", { protocolVersion: "1999-01-01" })).json.result.protocolVersion, "2025-06-18");
  });

  test("ping, notifications (no response), batches, parse errors and unknown methods", async () => {
    assert.deepEqual((await mcp(A, "ping")).json, { jsonrpc: "2.0", id: 1, result: {} });
    const note = await call("/mcp", { ...A, body: { jsonrpc: "2.0", method: "notifications/initialized" } });
    assert.equal(note.status, 202);
    assert.equal(note.text, "");
    const batch = await call("/mcp", { ...A, body: [{ jsonrpc: "2.0", id: "a", method: "ping" }, { jsonrpc: "2.0", id: "b", method: "ping" }] });
    assert.deepEqual(batch.json.map((x: { id: string }) => x.id), ["a", "b"]);
    const bad = await call("/mcp", { ...A, rawBody: "{nope", headers: { "content-type": "application/json" }, method: "POST" });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.json, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    const unknown = await mcp(A, "no/such/method", {}, 9);
    assert.deepEqual(unknown.json, { jsonrpc: "2.0", id: 9, error: { code: -32601, message: "Method not found: no/such/method" } });
  });

  test("GET and DELETE are 405: there is no server-initiated stream", async () => {
    const g = await call("/mcp", { method: "GET" });
    assert.equal(g.status, 405);
    assert.equal(g.headers.get("allow"), "POST");
    assert.equal((await call("/mcp", { method: "DELETE" })).status, 405);
  });
});

describe("POST /mcp: tools and prompts", () => {
  test("tools/list: every tool's name, input schema and read-only hint match the recorded contract", async () => {
    const r = await mcp(A, "tools/list");
    assert.equal(r.status, 200);
    const tools = [...r.json.result.tools]
      .sort((x: { name: string }, y: { name: string }) => x.name.localeCompare(y.name))
      .map((t: { name: string; inputSchema: unknown; annotations?: { readOnlyHint?: boolean } }) => ({ name: t.name, readOnly: !!t.annotations?.readOnlyHint, inputSchema: t.inputSchema }));
    assert.ok(tools.length > 30, "expected the full tool set");
    for (const t of r.json.result.tools) assert.ok(typeof t.description === "string" && t.description.length > 0, `${t.name} needs a description`);
    expectGolden("mcp-tools", tools);
  });

  test("every tool accepts the optional session argument the plugin hooks inject (ADR-4/5)", async () => {
    const r = await mcp(A, "tools/list");
    for (const t of r.json.result.tools) assert.ok(t.inputSchema.properties.session, `${t.name} has no session argument`);
  });

  test("tools/call returns the result as JSON text content", async () => {
    const r = await mcp(A, "tools/call", { name: "list_projects", arguments: {} });
    assert.equal(r.json.result.content[0].type, "text");
    assert.equal(r.json.result.isError, undefined);
    assert.ok(Array.isArray(mcpToolResult(r)));
  });

  test("tool errors are results with isError, formatted code: message", async () => {
    const unknown = await mcp(A, "tools/call", { name: "no_such_tool", arguments: {} });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.json.result.isError, true);
    assert.match(unknown.json.result.content[0].text, /^not_found: Unknown tool no_such_tool/);
    const invalid = await mcp(A, "tools/call", { name: "get_ticket", arguments: {} });
    assert.equal(invalid.json.result.isError, true);
    assert.match(invalid.json.result.content[0].text, /^invalid: /);
    const other = await mcp(A, "tools/call", { name: "get_board", arguments: { project: fx.b.teamKey } });
    assert.match(other.json.result.content[0].text, /^not_found: /, "another workspace's project looks like it does not exist");
  });

  test("a write through MCP is visible through the REST API", async () => {
    const title = `via mcp ${Date.now()}`;
    const made = mcpToolResult(await mcp(A, "tools/call", { name: "create_ticket", arguments: { project: fx.a.teamKey, title } }));
    assert.match(made.ref, new RegExp(`^${fx.a.teamKey}-\\d+$`));
    const got = (await call("/api/v1/get_ticket", { ...A, body: { ticket: made.ref } })).json.data;
    assert.equal(got.ticket.title, title);
  });

  test("prompts: the list is recorded, and a prompt renders messages", async () => {
    const list = await mcp(A, "prompts/list");
    expectGolden("mcp-prompts", [...list.json.result.prompts].map((p: { name: string; arguments?: unknown }) => ({ name: p.name, arguments: p.arguments ?? null })).sort((x, y) => x.name.localeCompare(y.name)));
    const brief = await mcp(A, "prompts/get", { name: "brief", arguments: { project: fx.a.teamKey } });
    assert.equal(brief.status, 200);
    assert.ok(Array.isArray(brief.json.result.messages) && brief.json.result.messages.length > 0);
    const missing = await mcp(A, "prompts/get", { name: "no-such-prompt" });
    assert.equal(missing.json.error.code, -32602);
  });
});
