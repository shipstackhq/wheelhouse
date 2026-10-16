import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { call, fx } from "./lib/http";
import { anon, app, login, ORIGIN, sessionFrom, signIn, newEmail } from "./lib/app";

/**
 * CSRF protection on the web app's API (WH-93). Every state-changing request needs the right Origin (when the browser
 * says one) AND the X-CSRF-Token for its session ("anonymous" before sign-in). A page on another site can do neither.
 */
const EVIL = "https://evil.example";

describe("sign-in (no session yet)", () => {
  test("from this site with the anonymous token: accepted", async () => {
    const r = await login(fx.a.email);
    assert.equal(r.status, 200);
  });

  test("without any token: refused, and no session is started", async () => {
    const r = await app("POST", "/api/app/auth/login", anon(), { csrf: null, body: { email: fx.a.email, password: fx.password } });
    assert.equal(r.status, 403);
    assert.deepEqual(r.json, { error: { code: "csrf_failed", message: "Missing or invalid CSRF token" } });
    assert.equal(r.cookies.length, 0);
  });

  test("from another site, even with the anonymous token and the right password (login CSRF): refused, no session", async () => {
    const r = await app("POST", "/api/app/auth/login", anon(), { origin: EVIL, body: { email: fx.a.email, password: fx.password } });
    assert.equal(r.status, 403);
    assert.deepEqual(r.json, { error: { code: "csrf_failed", message: "Cross-site request refused" } });
    assert.equal(r.cookies.length, 0, "a forged sign-in must not log the victim into another account");
  });

  test("a forged request that only has a Referer from another site is refused too", async () => {
    const r = await app("POST", "/api/app/auth/login", anon(), { origin: null, headers: { referer: `${EVIL}/page` }, body: { email: fx.a.email, password: fx.password } });
    assert.equal(r.status, 403);
  });

  test("an opaque origin ('null', from sandboxed pages) is refused", async () => {
    const r = await app("POST", "/api/app/auth/login", anon(), { origin: "null", body: { email: fx.a.email, password: fx.password } });
    assert.equal(r.status, 403);
  });

  test("a client that sends no Origin or Referer (curl, a native app) is judged by the token alone", async () => {
    assert.equal((await app("POST", "/api/app/auth/login", anon(), { origin: null, body: { email: fx.a.email, password: fx.password } })).status, 200);
    assert.equal((await app("POST", "/api/app/auth/login", anon(), { origin: null, csrf: "wrong", body: { email: fx.a.email, password: fx.password } })).status, 403);
  });
});

describe("a signed-in session", () => {
  test("the token from /me works; nothing else does", async () => {
    const s = await signIn(fx.a.email);
    assert.equal((await app("POST", "/api/app/auth/logout", s, { csrf: null })).status, 403, "no token");
    assert.equal((await app("POST", "/api/app/auth/logout", s, { csrf: "anonymous" })).status, 403, "the anonymous token is not valid once signed in");
    assert.equal((await app("POST", "/api/app/auth/logout", s, { csrf: "x".repeat(43) })).status, 403, "a made-up token");
    const me = await app("GET", "/api/app/me", s);
    assert.equal(me.json.csrfToken, s.csrf);
    assert.equal((await app("POST", "/api/app/auth/logout", s, { csrf: me.json.csrfToken })).status, 200);
  });

  test("a token is bound to its own session: another session's token is refused", async () => {
    const first = await signIn(fx.a.email);
    const second = await signIn(fx.a.email);
    assert.notEqual(first.csrf, second.csrf);
    assert.equal((await app("POST", "/api/app/auth/logout", second, { csrf: first.csrf })).status, 403);
    assert.equal((await app("POST", "/api/app/auth/logout", first)).status, 200);
    assert.equal((await app("POST", "/api/app/auth/logout", second)).status, 200);
  });

  test("a cross-site request is refused even carrying the valid token and cookie", async () => {
    const s = await signIn(fx.a.email);
    const r = await app("POST", "/api/app/auth/logout", s, { origin: EVIL });
    assert.equal(r.status, 403);
    assert.equal(r.json.error.message, "Cross-site request refused");
    assert.equal((await app("GET", "/api/app/me", s)).status, 200, "and the session was not ended by it");
    await app("POST", "/api/app/auth/logout", s);
  });

  test("after sign-out the old token is useless for a new request", async () => {
    const s = await signIn(fx.a.email);
    await app("POST", "/api/app/auth/logout", s);
    const r = await app("POST", "/api/app/auth/login", { cookie: null, csrf: s.csrf }, { body: { email: fx.a.email, password: fx.password } });
    assert.equal(r.status, 403, "a signed-out request must use 'anonymous'");
  });
});

describe("what a browser on another site can and cannot do", () => {
  test("GET is not checked, but the answer is not shared with other sites: no CORS headers, and a preflight is not approved", async () => {
    const s = await signIn(fx.a.email);
    const read = await app("GET", "/api/app/me", s, { origin: EVIL });
    assert.equal(read.status, 200);
    assert.equal(read.headers.get("access-control-allow-origin"), null);
    assert.equal(read.headers.get("access-control-allow-credentials"), null);
    const preflight = await call("/api/app/auth/login", { method: "OPTIONS", headers: { origin: EVIL, "access-control-request-method": "POST", "access-control-request-headers": "x-csrf-token,content-type" } });
    assert.equal(preflight.headers.get("access-control-allow-origin"), null);
    assert.equal(preflight.headers.get("access-control-allow-headers"), null);
    await app("POST", "/api/app/auth/logout", s);
  });

  test("a plain HTML form post (no custom header possible) is refused", async () => {
    const r = await call("/api/app/auth/login", {
      method: "POST",
      headers: { origin: EVIL, "content-type": "application/x-www-form-urlencoded" },
      rawBody: `email=${encodeURIComponent(fx.a.email)}&password=${encodeURIComponent(fx.password)}`,
    });
    assert.equal(r.status, 403);
    assert.equal(r.cookies.length, 0);
  });

  test("the origin check does not break a legitimate client on this site", async () => {
    const r = await app("POST", "/api/app/auth/signup", anon(), { origin: ORIGIN, body: { name: "Csrf Ok", email: newEmail(), password: "a-long-enough-password" } });
    assert.equal(r.status, 201);
    await app("POST", "/api/app/auth/logout", sessionFrom(r));
  });
});
