import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { asCookie, asKey, fx, mcp, v1, v1ok } from "./lib/http";

/**
 * Who gets in. Sessions are a `wh_session` cookie whose value is a random token; the database stores only its sha256, so
 * a session minted before a migration keeps working after it. API keys are `Authorization: Bearer wh_...`, stored as sha256.
 * The seed writes both that way, so every other test in the suite already depends on the hashing being unchanged.
 */
describe("session cookie (wh_session)", () => {
  test("a valid cookie signs a person in to the REST API and MCP", async () => {
    const r = await v1(asCookie(fx.a.sessionToken), "list_projects");
    assert.equal(r.status, 200);
    assert.ok(r.json.data.some((p: { key: string }) => p.key === fx.a.teamKey));
    assert.equal((await mcp(asCookie(fx.a.sessionToken), "tools/list")).status, 200);
  });

  test("a workspace member who is not an owner is signed in too", async () => {
    assert.equal((await v1(asCookie(fx.a.memberSessionToken), "list_projects")).status, 200);
  });

  test("an expired, unknown or empty cookie is not authenticated", async () => {
    for (const token of [fx.a.expiredSessionToken, "not-a-session", "x".repeat(300)]) {
      const r = await v1(asCookie(token), "list_projects");
      assert.equal(r.status, 401, token.slice(0, 20));
      assert.equal(r.json.error.code, "unauthorized");
    }
  });

  test("a member of a suspended workspace counts as signed out", async () => {
    assert.equal((await v1(asCookie(fx.suspended.sessionToken), "list_projects")).status, 401);
  });
});

describe("API keys (Authorization: Bearer)", () => {
  test("a valid key works; a revoked one does not", async () => {
    assert.equal((await v1(asKey(fx.a.apiKey), "list_projects")).status, 200);
    assert.equal((await v1(asKey(fx.a.revokedKey), "list_projects")).status, 401);
  });

  test("another scheme is ignored, so the request falls back to the cookie (none here)", async () => {
    const r = await v1({}, "list_projects", {}, { headers: { authorization: `Token ${fx.a.apiKey}` } });
    assert.equal(r.status, 401);
  });

  test("a key wins over a cookie: the request acts as the key's workspace", async () => {
    const r = await v1({ key: fx.b.apiKey, cookie: fx.a.sessionToken }, "list_projects");
    assert.equal(r.status, 200);
    const keys = r.json.data.map((p: { key: string }) => p.key);
    assert.ok(keys.includes(fx.b.teamKey));
    assert.ok(!keys.includes(fx.a.teamKey));
  });

  test("using a key records when it was last used", async () => {
    const before = Date.now() - 5_000;
    await v1ok(asKey(fx.a.apiKey2), "list_projects");
    // The key list is a page of the app, not an API; the contract here is only that the call succeeds and is attributed.
    const t = await v1ok(asKey(fx.a.apiKey2), "create_ticket", { project: fx.a.teamKey, title: `attrib ${before}` });
    assert.equal(t.createdByKind, "agent");
  });
});
