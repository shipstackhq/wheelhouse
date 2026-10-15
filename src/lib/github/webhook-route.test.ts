/** The webhook endpoint itself (WH-20): what it answers before and after the signature is checked. In-memory PGlite. */
process.env.PGLITE_DIR = "memory://";
delete process.env.DATABASE_URL;

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { POST } from "@/app/api/webhooks/github/route";
import { signBody } from "./signature";

const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const SECRET = "route-test-secret";
const KEYS = ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  Object.assign(process.env, { GITHUB_APP_ID: "1", GITHUB_APP_SLUG: "wh-test", GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_WEBHOOK_SECRET: SECRET, GITHUB_CLIENT_ID: "c", GITHUB_CLIENT_SECRET: "s" });
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const hook = (body: string, headers: Record<string, string> = {}, sign = true) =>
  POST(
    new Request("http://localhost/api/webhooks/github", {
      method: "POST",
      body,
      headers: { "x-github-event": "ping", "x-github-delivery": `route-${Math.random().toString(16).slice(2)}`, ...(sign ? { "x-hub-signature-256": signBody(SECRET, body) } : {}), ...headers },
    }),
  );

describe("the webhook endpoint", () => {
  test("a signed ping is accepted", async () => {
    const res = await hook('{"zen":"x"}');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "handled", detail: "pong" });
  });

  test("without the signature, or with a wrong one, it is a plain 401 and nothing is read", async () => {
    assert.equal((await hook('{"zen":"x"}', {}, false)).status, 401);
    assert.equal((await hook('{"zen":"x"}', { "x-hub-signature-256": signBody("wrong", '{"zen":"x"}') })).status, 401);
    assert.equal((await hook('{"zen":"x"}', { "x-hub-signature-256": "sha256=nothex" })).status, 401);
    const bad = await hook("not even json", {}, false);
    assert.equal(bad.status, 401, "an unsigned body is refused before anyone looks at it");
    assert.equal(await bad.text(), "Bad signature", "and the answer says nothing else");
  });

  test("a body changed after signing is refused", async () => {
    const res = await POST(
      new Request("http://localhost/api/webhooks/github", { method: "POST", body: '{"zen":"changed"}', headers: { "x-github-event": "ping", "x-github-delivery": "tamper", "x-hub-signature-256": signBody(SECRET, '{"zen":"x"}') } }),
    );
    assert.equal(res.status, 401);
  });

  test("signed but incomplete or malformed requests get a 400", async () => {
    assert.equal((await hook('{"a":1}', { "x-github-event": "" })).status, 400);
    assert.equal((await hook('{"a":1}', { "x-github-delivery": "" })).status, 400);
    assert.equal((await hook("not json")).status, 400);
  });

  test("a redelivery is recognised and changes nothing", async () => {
    const id = "route-dup";
    assert.equal((await (await hook('{"a":1}', { "x-github-delivery": id })).json()).status, "handled");
    assert.equal((await (await hook('{"a":1}', { "x-github-delivery": id })).json()).status, "duplicate");
  });

  test("an event we do not use is acknowledged and ignored", async () => {
    const res = await hook('{"action":"created"}', { "x-github-event": "star" });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "ignored");
  });

  test("an oversized body is refused", async () => {
    const big = JSON.stringify({ pad: "x".repeat(5 * 1024 * 1024 + 10) });
    assert.equal((await hook(big)).status, 413);
  });

  test("with the App not configured the endpoint says so and does nothing else", async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    assert.equal((await hook('{"zen":"x"}')).status, 503);
  });
});
