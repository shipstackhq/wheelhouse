/**
 * Signing up and in (WH-93): the rules the Next server actions and the API share. In-memory PGlite, or a real Postgres
 * with TEST_DATABASE_URL.
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  process.env.PGLITE_DIR = "memory://";
  delete process.env.DATABASE_URL;
}

import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../../db";
import { AccountError, WORKSPACE_SUSPENDED_MESSAGE } from "./auth-errors";
import { sha256 } from "../../common/crypto";
import { logIn, signUp, endSession, startSession } from "./auth.legacy";
import { appFailure } from "../../common/errors/api-errors";
import { verifyPassword } from "./passwords";
import { resetRateLimit } from "../../common/rate-limit";
import { testApp } from "../../test/app";
await testApp();

const PASSWORD = "correct horse battery";
let n = 0;
const fresh = () => {
  n++;
  return { ip: `198.51.100.${n}`, email: `acct-${n}-${Math.random().toString(16).slice(2, 7)}@example.test` };
};
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof AccountError, `expected an AccountError, got ${e}`);
    return e;
  }
  assert.fail("expected a refusal");
};
const saved = process.env.ALLOW_SIGNUP;
afterEach(() => {
  if (saved === undefined) delete process.env.ALLOW_SIGNUP;
  else process.env.ALLOW_SIGNUP = saved;
});

describe("signUp", () => {
  test("creates the user, a workspace they own, and stores a password that verifies", async () => {
    process.env.ALLOW_SIGNUP = "true";
    const { ip, email } = fresh();
    const { userId } = await signUp({ name: "  Ada ", email: `  ${email.toUpperCase()} `, password: PASSWORD }, ip);
    const db = await getDb();
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    assert.equal(u.email, email, "emails are trimmed and lower-cased");
    assert.equal(u.name, "Ada");
    assert.ok(await verifyPassword(PASSWORD, u.passwordHash));
    assert.ok(!(await verifyPassword("wrong", u.passwordHash)));
    const [m] = await db.select().from(schema.memberships).where(eq(schema.memberships.userId, userId));
    assert.equal(m.role, "owner");
    const [t] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, m.workspaceId));
    assert.equal(t.name, "Ada's workspace", "the workspace is named after the person unless they choose a name");
    const second = fresh();
    const two = await signUp({ name: "Bo", email: second.email, password: PASSWORD, workspace: " Acme " }, second.ip);
    const [m2] = await db.select().from(schema.memberships).where(eq(schema.memberships.userId, two.userId));
    assert.equal((await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, m2.workspaceId)))[0].name, "Acme");
  });

  test("is refused when signups are closed, except for the very first account", async () => {
    process.env.ALLOW_SIGNUP = "false";
    // The first account is always allowed, so make sure there already is one whatever order the tests run in.
    const db = await getDb();
    await db.insert(schema.users).values({ email: `first-${Math.random().toString(16).slice(2, 8)}@example.test`, name: "First", passwordHash: "x" });
    const e = await refusal(signUp({ name: "Cy", email: fresh().email, password: PASSWORD }, fresh().ip));
    assert.equal(e.code, "signup_closed");
    assert.equal(e.status, 403);
    assert.equal(e.message, "Signups are closed. Ask a workspace owner to add you.");
  });

  test("says what is wrong, with the same messages as before, and which field", async () => {
    process.env.ALLOW_SIGNUP = "true";
    const noName = await refusal(signUp({ name: " ", email: fresh().email, password: PASSWORD }, fresh().ip));
    assert.equal(noName.message, "Enter your name and a valid email");
    assert.deepEqual(Object.keys(noName.fields!), ["name"]);
    const badEmail = await refusal(signUp({ name: "Di", email: "not-an-email", password: PASSWORD }, fresh().ip));
    assert.equal(badEmail.message, "Enter your name and a valid email");
    assert.deepEqual(Object.keys(badEmail.fields!), ["email"]);
    const weak = await refusal(signUp({ name: "Di", email: fresh().email, password: "short" }, fresh().ip));
    assert.equal(weak.message, "Password must be at least 12 characters");
    assert.equal(weak.fields!.password, weak.message);
    assert.equal(weak.status, 400);
  });

  test("an email that already has an account is a conflict", async () => {
    process.env.ALLOW_SIGNUP = "true";
    const { ip, email } = fresh();
    await signUp({ name: "Ed", email, password: PASSWORD }, ip);
    const e = await refusal(signUp({ name: "Ed again", email: email.toUpperCase(), password: PASSWORD }, fresh().ip));
    assert.equal(e.code, "conflict");
    assert.equal(e.status, 409);
    assert.equal(e.message, "An account with that email already exists");
  });

  test("ten signups an hour per address, then a rate limit with the wait in minutes", async () => {
    process.env.ALLOW_SIGNUP = "true";
    const { ip } = fresh();
    for (let i = 0; i < 10; i++) await signUp({ name: "Fay", email: fresh().email, password: PASSWORD }, ip);
    const e = await refusal(signUp({ name: "Fay", email: fresh().email, password: PASSWORD }, ip));
    assert.equal(e.code, "rate_limited");
    assert.equal(e.status, 429);
    assert.match(e.message, /^Too many attempts\. Try again in \d+ minutes?\.$/);
    assert.ok(e.retryAfter! > 0);
    resetRateLimit(`signup:${ip}`);
  });
});

describe("logIn", () => {
  const account = async () => {
    process.env.ALLOW_SIGNUP = "true";
    const a = fresh();
    const { userId } = await signUp({ name: "Gus", email: a.email, password: PASSWORD }, a.ip);
    return { ...a, userId };
  };

  test("the right password signs in, whatever the case of the email", async () => {
    const a = await account();
    assert.equal((await logIn({ email: a.email.toUpperCase(), password: PASSWORD }, fresh().ip)).userId, a.userId);
  });

  test("a wrong password and an unknown email look exactly alike", async () => {
    const a = await account();
    const wrong = await refusal(logIn({ email: a.email, password: "nope" }, fresh().ip));
    const unknown = await refusal(logIn({ email: fresh().email, password: PASSWORD }, fresh().ip));
    for (const e of [wrong, unknown]) {
      assert.equal(e.code, "unauthorized");
      assert.equal(e.status, 401);
      assert.equal(e.message, "Invalid email or password");
    }
  });

  test("eight tries per account in 15 minutes, from any addresses; success starts the count again", async () => {
    const a = await account();
    for (let i = 0; i < 8; i++) assert.equal((await refusal(logIn({ email: a.email, password: "nope" }, fresh().ip))).code, "unauthorized");
    const locked = await refusal(logIn({ email: a.email, password: PASSWORD }, fresh().ip));
    assert.equal(locked.code, "rate_limited", "even the right password is held back once the account is locked");
    resetRateLimit(`login-email:${a.email}`);
    for (let i = 0; i < 6; i++) await refusal(logIn({ email: a.email, password: "nope" }, fresh().ip));
    await logIn({ email: a.email, password: PASSWORD }, fresh().ip);
    for (let i = 0; i < 7; i++) await refusal(logIn({ email: a.email, password: "nope" }, fresh().ip)); // would have been locked without the reset
  });

  test("thirty tries per address in 15 minutes, across accounts", async () => {
    const { ip } = fresh();
    for (let i = 0; i < 30; i++) assert.equal((await refusal(logIn({ email: fresh().email, password: "nope" }, ip))).code, "unauthorized");
    assert.equal((await refusal(logIn({ email: fresh().email, password: "nope" }, ip))).code, "rate_limited");
    resetRateLimit(`login-ip:${ip}`);
  });

  test("a suspended workspace is told only after the password is right", async () => {
    const a = await account();
    const db = await getDb();
    const [m] = await db.select().from(schema.memberships).where(eq(schema.memberships.userId, a.userId));
    await db.update(schema.workspaces).set({ suspendedAt: new Date() }).where(eq(schema.workspaces.id, m.workspaceId));
    assert.equal((await refusal(logIn({ email: a.email, password: "nope" }, fresh().ip))).message, "Invalid email or password");
    const e = await refusal(logIn({ email: a.email, password: PASSWORD }, fresh().ip));
    assert.equal(e.code, "team_suspended");
    assert.equal(e.status, 403);
    assert.equal(e.message, WORKSPACE_SUSPENDED_MESSAGE);
  });
});

describe("sessions", () => {
  test("only the sha256 of the cookie token is stored, it lasts 30 days, and ending it removes the row", async () => {
    process.env.ALLOW_SIGNUP = "true";
    const a = fresh();
    const { userId } = await signUp({ name: "Hal", email: a.email, password: PASSWORD }, a.ip);
    const { token, expiresAt } = await startSession(userId);
    const db = await getDb();
    const rows = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sha256(token)));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].userId, userId);
    assert.ok(!(await db.select().from(schema.sessions).where(eq(schema.sessions.id, token))).length, "the token itself is never stored");
    const days = (expiresAt.getTime() - Date.now()) / 864e5;
    assert.ok(days > 29.9 && days <= 30);
    await endSession(token);
    assert.equal((await db.select().from(schema.sessions).where(eq(schema.sessions.id, sha256(token)))).length, 0);
    await endSession(token);
    await endSession(undefined);
  });
});

describe("appFailure: the web app's error envelope", () => {
  test("an account error carries its code, status, fields and Retry-After", async () => {
    const f = appFailure(new AccountError("rate_limited", "Too many attempts. Try again in 5 minutes.", { retryAfter: 300 }));
    assert.equal(f.status, 429);
    assert.deepEqual(f.headers, { "Retry-After": "300" });
    assert.deepEqual(f.body, { error: { code: "rate_limited", message: "Too many attempts. Try again in 5 minutes.", details: undefined } });
    const g = appFailure(new AccountError("invalid", "Enter your name and a valid email", { fields: { name: "Enter your name" } }));
    assert.deepEqual((g.body as { error: { details: unknown } }).error.details, { fields: { name: "Enter your name" } });
  });
  test("everything else is the REST envelope", async () => {
    const { ServiceError } = await import("../../lib/service");
    const f = appFailure(new ServiceError("conflict", "changed", { current: { version: 3 } }));
    assert.equal(f.status, 409);
    assert.deepEqual(f.body, { error: { code: "conflict", message: "changed", details: { current: { version: 3 } } } });
  });
});
