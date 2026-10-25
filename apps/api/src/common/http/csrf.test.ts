import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ANONYMOUS_CSRF, checkCsrf, configuredOrigins, csrfToken, type CsrfInput } from "./csrf";

const SESSION = "s3ssion-token-value";
const base: CsrfInput = { method: "POST", origin: "https://wh.example", host: "wh.example", tokenHeader: csrfToken(SESSION), sessionToken: SESSION, allowedOrigins: [] };
const verdict = (over: Partial<CsrfInput>) => checkCsrf({ ...base, ...over });

describe("csrfToken", () => {
  test("is bound to the session, stable, and not the session itself", () => {
    assert.equal(csrfToken(SESSION), csrfToken(SESSION));
    assert.notEqual(csrfToken(SESSION), csrfToken(SESSION + "x"));
    assert.ok(!csrfToken(SESSION).includes(SESSION));
    assert.match(csrfToken(SESSION), /^[A-Za-z0-9_-]{43}$/);
  });
});

describe("checkCsrf", () => {
  test("safe methods are never checked", () => {
    for (const method of ["GET", "HEAD", "OPTIONS", "get"]) assert.deepEqual(verdict({ method, origin: "https://evil.example", tokenHeader: null }), { ok: true }, method);
  });

  test("a same-site POST with the session's token passes", () => {
    assert.deepEqual(verdict({}), { ok: true });
    for (const method of ["PUT", "PATCH", "DELETE", "post"]) assert.deepEqual(verdict({ method }), { ok: true }, method);
  });

  test("another site is refused, even with a valid token", () => {
    assert.deepEqual(verdict({ origin: "https://evil.example" }), { ok: false, reason: "origin" });
    assert.deepEqual(verdict({ origin: "https://wh.example.evil.example" }), { ok: false, reason: "origin" });
    assert.deepEqual(verdict({ origin: "https://evilwh.example" }), { ok: false, reason: "origin" });
  });

  test("an opaque or unreadable origin is refused", () => {
    assert.deepEqual(verdict({ origin: "null" }), { ok: false, reason: "origin" });
    assert.deepEqual(verdict({ origin: "not a url" }), { ok: false, reason: "origin" });
    assert.deepEqual(verdict({ origin: undefined, referer: "garbage" }), { ok: false, reason: "origin" });
  });

  test("without an Origin the Referer decides", () => {
    assert.deepEqual(verdict({ origin: undefined, referer: "https://wh.example/t/WH/board?x=1" }), { ok: true });
    assert.deepEqual(verdict({ origin: undefined, referer: "https://evil.example/page" }), { ok: false, reason: "origin" });
    assert.deepEqual(verdict({ origin: "https://wh.example", referer: "https://evil.example/" }), { ok: true }, "the Origin wins when both are sent");
  });

  test("with neither, only the token stands between a request and the handler", () => {
    assert.deepEqual(verdict({ origin: undefined, referer: undefined }), { ok: true });
    assert.deepEqual(verdict({ origin: undefined, referer: undefined, tokenHeader: "wrong" }), { ok: false, reason: "token" });
  });

  test("the token must be present and right", () => {
    assert.deepEqual(verdict({ tokenHeader: null }), { ok: false, reason: "token" });
    assert.deepEqual(verdict({ tokenHeader: "" }), { ok: false, reason: "token" });
    assert.deepEqual(verdict({ tokenHeader: csrfToken("another session") }), { ok: false, reason: "token" });
    assert.deepEqual(verdict({ tokenHeader: csrfToken(SESSION).slice(0, -1) }), { ok: false, reason: "token" });
    assert.deepEqual(verdict({ tokenHeader: ANONYMOUS_CSRF }), { ok: false, reason: "token" }, "a signed-in request cannot use the anonymous token");
  });

  test("before sign-in the token is the literal 'anonymous', and a stale session token is no use", () => {
    assert.deepEqual(verdict({ sessionToken: null, tokenHeader: ANONYMOUS_CSRF }), { ok: true });
    assert.deepEqual(verdict({ sessionToken: null, tokenHeader: csrfToken(SESSION) }), { ok: false, reason: "token" });
    assert.deepEqual(verdict({ sessionToken: null, tokenHeader: null }), { ok: false, reason: "token" });
    assert.deepEqual(verdict({ sessionToken: null, tokenHeader: ANONYMOUS_CSRF, origin: "https://evil.example" }), { ok: false, reason: "origin" }, "login CSRF");
  });

  test("configured origins are trusted, and the host match ignores case", () => {
    const v = (origin: string) => verdict({ origin, host: "internal:3460", allowedOrigins: ["https://wh.example", "http://localhost:5173"] });
    assert.deepEqual(v("https://wh.example"), { ok: true });
    assert.deepEqual(v("http://localhost:5173"), { ok: true });
    assert.deepEqual(v("http://localhost:5174"), { ok: false, reason: "origin" });
    assert.deepEqual(verdict({ origin: "HTTPS://WH.EXAMPLE", host: "WH.example" }), { ok: true });
  });
});

describe("configuredOrigins", () => {
  test("reads APP_URL and APP_ORIGINS, as origins, ignoring junk", () => {
    assert.deepEqual(configuredOrigins({ APP_URL: "https://wh.example/some/path/", APP_ORIGINS: "http://localhost:5173, nonsense ,https://b.example" }), ["https://wh.example", "http://localhost:5173", "https://b.example"]);
    assert.deepEqual(configuredOrigins({}), []);
  });
});
