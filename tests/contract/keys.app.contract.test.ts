import { describe, test, before } from "node:test";
import assert from "node:assert/strict";
import { asKey, mcp, mcpToolResult, openSse, v1, v1ok } from "./lib/http";
import { anon, app, newAccount, type Sess } from "./lib/app";

/**
 * Agent keys scoped to teams (WH-120): choosing the teams when a key is made, and what a scoped key can and cannot reach over
 * /api/v1, the MCP and the live streams. Runs in a workspace made for the test.
 */

let owner: Sess;
let t1: string;
let t2: string;
let k = 0;
const newKey = () => `K${Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 3).toUpperCase()}${String.fromCharCode(65 + (k++ % 26))}`;

type Key = { id: string; name: string; teams: { key: string; name: string }[] };
const makeKey = async (body: Record<string, unknown>, s: Sess = owner) => app("POST", "/api/app/keys", s, { body: { name: "agent", ...body } });

before(async () => {
  owner = (await newAccount("Owner")).sess;
  t1 = newKey();
  t2 = newKey();
  for (const key of [t1, t2]) assert.equal((await app("POST", "/api/app/teams", owner, { body: { name: `Team ${key}`, key } })).status, 201);
  assert.equal((await app("POST", `/api/app/teams/${t1}/issues`, owner, { body: { title: "T1 issue" } })).status, 201);
  assert.equal((await app("POST", `/api/app/teams/${t2}/issues`, owner, { body: { title: "T2 issue" } })).status, 201);
});

describe("choosing a key's teams", () => {
  test("a key is made for the teams you pick; left out, it gets every team you can edit; the API keys page lists them", async () => {
    const narrow = await makeKey({ teams: [t1] });
    assert.equal(narrow.status, 201, narrow.text);
    assert.deepEqual((narrow.json.key as Key).teams.map((t) => t.key), [t1]);
    const wide = await makeKey({});
    assert.deepEqual((wide.json.key as Key).teams.map((t) => t.key).sort(), [t1, t2].sort());
    const page = (await app("GET", "/api/app/keys", owner)).json.keys as Key[];
    assert.deepEqual(page.find((x) => x.id === narrow.json.key.id)!.teams.map((t) => t.key), [t1]);
  });

  test("a bad list is a 400 naming teams; a team you cannot edit or that does not exist is a 404", async () => {
    for (const teams of [[], "AA", [1]]) {
      const r = await makeKey({ teams });
      assert.equal(r.status, 400, r.text);
      assert.ok(r.json.error.details?.fields?.teams, r.text);
    }
    assert.equal((await makeKey({ teams: ["NOPE"] })).status, 404);
    const other = await newAccount("Other");
    assert.equal((await makeKey({ teams: [t1] }, other.sess)).status, 404, "another workspace's team key is not found for them");
  });

  test("the teams of a key can be changed, and the change takes effect at once", async () => {
    const made = await makeKey({ teams: [t1] });
    const key = made.json.key as Key;
    const secret = made.json.secret as string;
    assert.equal((await v1(asKey(secret), "list_issues", { team: t2 })).status, 404);
    const patched = await app("PATCH", `/api/app/keys/${key.id}`, owner, { body: { teams: [t1, t2] } });
    assert.equal(patched.status, 200, patched.text);
    assert.deepEqual((patched.json.key as Key).teams.map((t) => t.key).sort(), [t1, t2].sort());
    assert.equal((await v1(asKey(secret), "list_issues", { team: t2 })).status, 200);
    assert.equal((await app("PATCH", `/api/app/keys/${key.id}`, owner, { body: { teams: [t2] } })).status, 200);
    assert.equal((await v1(asKey(secret), "list_issues", { team: t1 })).status, 404, "taking a team away closes it");
    assert.equal((await app("PATCH", `/api/app/keys/${key.id}`, owner, { body: { teams: [] } })).status, 400);
    assert.equal((await app("PATCH", `/api/app/keys/${key.id}`, owner, { body: {} })).status, 400);
    assert.equal((await app("PATCH", `/api/app/keys/${key.id}`, anon(), { body: { teams: [t1] } })).status, 401);
  });
});

describe("what a scoped key reaches", () => {
  let secret: string;
  before(async () => {
    secret = (await makeKey({ teams: [t1] })).json.secret as string;
  });

  test("/api/v1: its team works, any other team of the workspace is a 404 for every kind of call", async () => {
    assert.ok((await v1ok(asKey(secret), "list_issues", { team: t1 })).counts, "its own team lists");
    assert.deepEqual((await v1ok(asKey(secret), "get_briefing")).teams.map((p: { key: string }) => p.key), [t1]);
    const refused: [string, Record<string, unknown>][] = [
      ["list_issues", { team: t2 }],
      ["get_issue", { ref: `${t2}-1` }],
      ["create_issue", { team: t2, title: "planted" }],
      ["update_issue", { ref: `${t2}-1`, title: "hijacked" }],
      ["comment", { ref: `${t2}-1`, body: "hello" }],
      ["get_changes", { team: t2 }],
      ["get_briefing", { team: t2 }],
      ["list_knowledge", { team: t2, kind: "docs" }],
    ];
    for (const [tool, args] of refused) {
      const r = await v1(asKey(secret), tool, args);
      assert.equal(r.status, 404, `${tool}: ${r.text}`);
      assert.equal(r.json.error.code, "not_found");
    }
    const existing = await v1(asKey(secret), "list_issues", { team: "ZZZZ" });
    const other = await v1(asKey(secret), "list_issues", { team: t2 });
    assert.equal(other.json.error.message.replace(t2, "X"), existing.json.error.message.replace("ZZZZ", "X"), "a team it cannot open reads like one that does not exist");
    assert.equal((await app("GET", `/api/app/teams/${t2}/board`, owner)).json.issues.length, 1, "and nothing of T2 changed");
  });

  test("the MCP gives the same answers", async () => {
    const list = mcpToolResult(await mcp(asKey(secret), "tools/call", { name: "get_briefing", arguments: {} }));
    assert.deepEqual(list.teams.map((p: { key: string }) => p.key), [t1]);
    const r = await mcp(asKey(secret), "tools/call", { name: "list_issues", arguments: { team: t2 } });
    assert.equal(r.json.result.isError, true);
    assert.match(r.json.result.content[0].text, /^not_found:/);
  });

  test("streams are for people: a key, scoped or not, is refused", async () => {
    assert.equal((await openSse(`/api/teams/${t1}/stream`, { key: secret })).status, 403);
    assert.equal((await openSse(`/api/teams/${t2}/stream`, { key: secret })).status, 403);
    assert.equal((await openSse("/api/stream", { key: secret })).status, 403);
  });
});
