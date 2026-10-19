import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { call, deliver, deliveryId, fx } from "./lib/http";
import { app, signIn } from "./lib/app";

/**
 * Run against a server with NO GitHub App configured (the runner's second pass). With the integration off, it must say so
 * plainly and never half-work.
 */
describe("with no GitHub App configured", () => {
  test("the fixtures say so", () => {
    assert.equal(fx.github, null);
  });

  test("the webhook is a 503 with a plain message, whatever is sent", async () => {
    const r = await call("/api/webhooks/github", { method: "POST", headers: { "x-github-event": "ping", "x-github-delivery": deliveryId() }, rawBody: "{}" });
    assert.equal(r.status, 503);
    assert.equal(r.text, "The GitHub App is not configured on this server");
    assert.equal((await deliver("ping", { zen: "x" }, { secret: "anything" })).status, 503);
  });

  test("an owner starting the connection is sent back to the repositories page with not_configured", async () => {
    const r = await call(`/api/github/install?team=${fx.a.teamKey}`, { cookie: fx.a.sessionToken });
    assert.equal(r.status, 307);
    const to = new URL(r.headers.get("location")!, "http://x");
    assert.equal(to.pathname, `/t/${fx.a.teamKey}/repos`);
    assert.equal(to.searchParams.get("github_error"), "not_configured");
  });

  test("the Connect GitHub card says so: an owner is told which settings are missing, a member is not, and connecting is refused", async () => {
    const owner = await signIn(fx.a.email);
    const r = await app("GET", `/api/app/teams/${fx.a.teamKey}/repositories/github`, owner);
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.configured, r.json.isOwner, r.json.installations], [false, true, []]);
    assert.ok(r.json.missing.includes("GITHUB_APP_ID"));
    const member = await app("GET", `/api/app/teams/${fx.a.teamKey}/repositories/github`, await signIn(fx.a.memberEmail));
    assert.deepEqual([member.json.configured, member.json.missing], [false, []]);
    const connect = await app("POST", `/api/app/teams/${fx.a.teamKey}/repositories/github`, owner, { body: { installationId: "1", repoId: "2" } });
    assert.ok(connect.status >= 400 && connect.status < 500, `${connect.status}`);
  });

  test("the callback is a 503", async () => {
    const r = await call("/api/github/callback?state=x&installation_id=1&code=y", { cookie: fx.a.sessionToken });
    assert.equal(r.status, 503);
    assert.equal(r.text, "The GitHub App is not configured on this server");
  });

  test("the rest of the API still works", async () => {
    assert.equal((await call("/api/health")).status, 200);
    const r = await call("/api/v1/list_projects", { key: fx.a.apiKey, method: "POST", body: {} });
    assert.equal(r.status, 200);
  });
});
