import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fx, freshIp, unique, v1 } from "./lib/http";
import { anon, app, login, newEmail, sessionFrom, signIn } from "./lib/app";
import { expectGolden } from "./lib/golden";
import { shape } from "./lib/shape";

describe("GET /api/app/auth/options", () => {
  test("tells a signed-out page whether it may offer sign-up", async () => {
    const r = await app("GET", "/api/app/auth/options");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { signupOpen: true });
  });
});

describe("POST /api/app/auth/login", () => {
  test("starts a session: the person, their team and role, the CSRF token, and the same cookie the Next app sets", async () => {
    const r = await login(fx.a.email);
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json).sort(), ["csrfToken", "isInstanceAdmin", "role", "team", "user"]);
    assert.deepEqual(r.json.user, { id: fx.a.userId, name: "Contract A owner", email: fx.a.email });
    assert.equal(r.json.team.id, fx.a.teamId);
    assert.equal(r.json.role, "owner");
    assert.equal(r.json.isInstanceAdmin, false);
    assert.ok(!r.text.includes("passwordHash") && !r.text.includes("password_hash"), "no password hash in the response");

    const set = r.cookies.find((c) => c.startsWith("wh_session="))!;
    assert.ok(set, "the wh_session cookie");
    assert.match(set, /HttpOnly/i);
    assert.match(set, /SameSite=Lax/i);
    assert.match(set, /Path=\//i);
    if (process.env.CONTRACT_EXPECT_SECURE === "1") assert.match(set, /Secure/i);
    const expires = new Date(/Expires=([^;]+)/i.exec(set)![1]).getTime();
    const days = (expires - Date.now()) / 864e5;
    assert.ok(days > 29.5 && days < 30.5, `expires in ${days.toFixed(2)} days, expected 30`);
    const token = decodeURIComponent(set.split(";")[0].slice("wh_session=".length));
    assert.ok(token.length >= 40, "a long random token");
  });

  test("that cookie is the same session the frozen API honours (a person signed in here can call /api/v1)", async () => {
    const s = await signIn(fx.a.email);
    const r = await v1({ cookie: s.cookie }, "list_projects");
    assert.equal(r.status, 200);
    assert.ok(r.json.data.some((p: { key: string }) => p.key === fx.a.projectKey));
    await app("POST", "/api/app/auth/logout", s);
  });

  test("a member signs in as a member", async () => {
    const r = await login(fx.a.memberEmail);
    assert.equal(r.status, 200);
    assert.equal(r.json.role, "member");
    assert.equal(r.json.team.id, fx.a.teamId);
  });

  test("a wrong password and an unknown email are the same answer: 401, no cookie", async () => {
    for (const [email, password] of [[fx.a.email, "not-the-password"], [newEmail(), fx.password]] as const) {
      const r = await login(email, password);
      assert.equal(r.status, 401);
      assert.deepEqual(r.json, { error: { code: "unauthorized", message: "Invalid email or password" } });
      assert.equal(r.cookies.length, 0);
    }
  });

  test("a suspended team's member who knows the password is told so; one who does not, is not", async () => {
    const wrong = await login(fx.suspended.email, "nope");
    assert.equal(wrong.json.error.message, "Invalid email or password");
    const right = await login(fx.suspended.email);
    assert.equal(right.status, 403);
    assert.equal(right.json.error.code, "team_suspended");
    assert.equal(right.json.error.message, "This team has been suspended. Contact the administrator.");
    assert.equal(right.cookies.length, 0);
  });

  test("a body that is not a JSON object is a 400 in the usual envelope", async () => {
    for (const rawBody of ["{not json", "[1,2]", '"text"']) {
      const r = await app("POST", "/api/app/auth/login", anon(), { rawBody, headers: { "content-type": "application/json" } });
      assert.equal(r.status, 400, rawBody);
      assert.equal(r.json.error.code, "invalid");
    }
    const empty = await app("POST", "/api/app/auth/login", anon(), { rawBody: "" });
    assert.equal(empty.status, 401, "an empty body is just missing credentials");
  });

  test("eight wrong tries on one account lock it for 15 minutes, from any address, with a Retry-After", async () => {
    const email = newEmail();
    const made = await app("POST", "/api/app/auth/signup", anon(), { body: { name: "Lockout", email, password: "a-long-enough-password" } });
    await app("POST", "/api/app/auth/logout", sessionFrom(made));
    for (let i = 0; i < 8; i++) assert.equal((await login(email, "wrong password", { ip: freshIp() })).status, 401);
    const locked = await login(email, "a-long-enough-password", { ip: freshIp() });
    assert.equal(locked.status, 429);
    assert.equal(locked.json.error.code, "rate_limited");
    assert.match(locked.json.error.message, /^Too many attempts\. Try again in \d+ minutes?\.$/);
    assert.match(locked.headers.get("retry-after") ?? "", /^\d+$/);
  });
});

describe("POST /api/app/auth/signup", () => {
  test("creates an account and a team they own, and signs them in (201)", async () => {
    const email = newEmail();
    const r = await app("POST", "/api/app/auth/signup", anon(), { body: { name: "  Ivy  ", email: email.toUpperCase(), password: "a-long-enough-password", team: "Ivy Inc" } });
    assert.equal(r.status, 201);
    assert.equal(r.json.user.name, "Ivy");
    assert.equal(r.json.user.email, email, "lower-cased");
    assert.equal(r.json.team.name, "Ivy Inc");
    assert.equal(r.json.role, "owner");
    const s = sessionFrom(r);
    const me = await app("GET", "/api/app/me", s);
    assert.equal(me.json.team.id, r.json.team.id);
    const projects = await app("GET", "/api/app/projects", s);
    assert.deepEqual(projects.json, { projects: [] }, "a new team starts empty");
    assert.notEqual(r.json.team.id, fx.a.teamId);
    await app("POST", "/api/app/auth/logout", s);
  });

  test("the team is named after the person unless they choose a name", async () => {
    const r = await app("POST", "/api/app/auth/signup", anon(), { body: { name: "Jo", email: newEmail(), password: "a-long-enough-password" } });
    assert.equal(r.json.team.name, "Jo's team");
    await app("POST", "/api/app/auth/logout", sessionFrom(r));
  });

  test("problems come back with the field they belong to", async () => {
    const dup = await app("POST", "/api/app/auth/signup", anon(), { body: { name: "Dup", email: fx.a.email, password: "a-long-enough-password" } });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.error.code, "conflict");
    assert.equal(dup.json.error.message, "An account with that email already exists");
    assert.ok(dup.json.error.details.fields.email);

    const weak = await app("POST", "/api/app/auth/signup", anon(), { body: { name: "Weak", email: newEmail(), password: "short" } });
    assert.equal(weak.status, 400);
    assert.equal(weak.json.error.code, "invalid");
    assert.equal(weak.json.error.message, "Password must be at least 12 characters");
    assert.equal(weak.json.error.details.fields.password, weak.json.error.message);

    const nameless = await app("POST", "/api/app/auth/signup", anon(), { body: { name: " ", email: "nope", password: "a-long-enough-password" } });
    assert.equal(nameless.status, 400);
    assert.deepEqual(Object.keys(nameless.json.error.details.fields).sort(), ["email", "name"]);
    for (const r of [dup, weak, nameless]) assert.equal(r.cookies.length, 0, "no session on a refused signup");
  });
});

describe("GET /api/app/me", () => {
  test("signed out is a JSON 401 (never a redirect)", async () => {
    const r = await app("GET", "/api/app/me");
    assert.equal(r.status, 401);
    assert.deepEqual(r.json, { error: { code: "unauthorized", message: "Not authenticated" } });
  });

  test("an expired, unknown or suspended session is signed out too", async () => {
    for (const cookie of [fx.a.expiredSessionToken, "not-a-session", fx.suspended.sessionToken]) {
      const r = await app("GET", "/api/app/me", { cookie, csrf: "x" });
      assert.equal(r.status, 401, cookie.slice(0, 12));
    }
  });

  test("the CSRF token is stable for a session and different between sessions", async () => {
    const s = await signIn(fx.a.email);
    const one = await app("GET", "/api/app/me", s);
    const two = await app("GET", "/api/app/me", s);
    assert.equal(one.json.csrfToken, two.json.csrfToken);
    assert.equal(one.json.csrfToken, s.csrf);
    assert.notEqual((await signIn(fx.a.email)).csrf, s.csrf);
    await app("POST", "/api/app/auth/logout", s);
  });
});

describe("POST /api/app/auth/logout", () => {
  test("ends the session on the server and clears the cookie; the old cookie is dead", async () => {
    const s = await signIn(fx.a.email);
    const out = await app("POST", "/api/app/auth/logout", s);
    assert.equal(out.status, 200);
    assert.deepEqual(out.json, { ok: true });
    const clear = out.cookies.find((c) => c.startsWith("wh_session="))!;
    assert.ok(/Expires=Thu, 01 Jan 1970|Max-Age=0/i.test(clear), clear);
    assert.equal((await app("GET", "/api/app/me", s)).status, 401, "the session itself is gone, not just the cookie");
    assert.equal((await v1({ cookie: s.cookie }, "list_projects")).status, 401, "and it is gone for the frozen API as well");
  });

  test("signing out when not signed in is harmless", async () => {
    const r = await app("POST", "/api/app/auth/logout", anon());
    assert.equal(r.status, 200);
  });
});

describe("GET /api/app/projects", () => {
  test("lists only the signed-in person's own team's projects", async () => {
    const a = await app("GET", "/api/app/projects", await signIn(fx.a.email));
    const b = await app("GET", "/api/app/projects", await signIn(fx.b.email));
    assert.deepEqual(a.json.projects.map((p: { key: string }) => p.key), [fx.a.projectKey]);
    assert.deepEqual(b.json.projects.map((p: { key: string }) => p.key), [fx.b.projectKey]);
    assert.deepEqual(Object.keys(a.json.projects[0]).sort(), ["createdAt", "description", "id", "key", "name"]);
  });

  test("the team cannot be chosen by the request", async () => {
    const s = await signIn(fx.a.email);
    for (const path of [`/api/app/projects?teamId=${fx.b.teamId}`, `/api/app/projects?team=${fx.b.teamId}&project=${fx.b.projectKey}`]) {
      const r = await app("GET", path, s);
      assert.deepEqual(r.json.projects.map((p: { key: string }) => p.key), [fx.a.projectKey], path);
    }
    const header = await app("GET", "/api/app/projects", s, { headers: { "x-team-id": fx.b.teamId } });
    assert.deepEqual(header.json.projects.map((p: { key: string }) => p.key), [fx.a.projectKey]);
  });

  test("signed out is a 401", async () => {
    assert.equal((await app("GET", "/api/app/projects")).status, 401);
  });

  test("a new team sees none of another team's work", async () => {
    const made = await app("POST", "/api/app/auth/signup", anon(), { body: { name: unique("iso"), email: newEmail(), password: "a-long-enough-password" } });
    const s = sessionFrom(made);
    const list = await app("GET", "/api/app/projects", s);
    assert.deepEqual(list.json.projects, []);
    const board = await v1({ cookie: s.cookie }, "get_board", { project: fx.a.projectKey });
    assert.equal(board.status, 404);
    await app("POST", "/api/app/auth/logout", s);
  });
});

describe("the envelope", () => {
  test("errors have one shape everywhere, and it is recorded", async () => {
    const signedOut = await app("GET", "/api/app/me");
    const csrf = await app("POST", "/api/app/auth/login", anon(), { csrf: null, body: {} });
    const fields = await app("POST", "/api/app/auth/signup", anon(), { body: { name: "", email: "x", password: "short" } });
    const limited = shape({ error: { code: "rate_limited", message: "Too many attempts. Try again in 5 minutes." } });
    expectGolden("app-error-envelopes", { unauthorized: shape(signedOut.json), csrf_failed: shape(csrf.json), invalid_with_fields: shape(fields.json), rate_limited: limited });
  });

  test("a successful sign-in has one recorded shape", async () => {
    const r = await login(fx.a.email);
    expectGolden("app-me", shape(r.json));
    await app("POST", "/api/app/auth/logout", sessionFrom(r));
  });
});
