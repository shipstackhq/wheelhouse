/** Rate limiter, client address parsing and signup policy (WH-27). */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { clientIp, rateLimit, resetRateLimit } from "./rate-limit";
import { signupOpen } from "./auth-policy";

describe("rateLimit", () => {
  test("allows up to the limit, then blocks with a retry time", () => {
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) assert.equal(rateLimit("a", 3, 60_000, t).ok, true);
    const blocked = rateLimit("a", 3, 60_000, t + 10_000);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.retryAfter, 50);
  });

  test("the window rolls over", () => {
    const t = 2_000_000;
    for (let i = 0; i < 4; i++) rateLimit("b", 3, 60_000, t);
    assert.equal(rateLimit("b", 3, 60_000, t).ok, false);
    assert.equal(rateLimit("b", 3, 60_000, t + 60_001).ok, true);
  });

  test("keys are independent", () => {
    const t = 3_000_000;
    for (let i = 0; i < 4; i++) rateLimit("c1", 3, 60_000, t);
    assert.equal(rateLimit("c1", 3, 60_000, t).ok, false);
    assert.equal(rateLimit("c2", 3, 60_000, t).ok, true);
  });

  test("reset clears a key", () => {
    const t = 4_000_000;
    for (let i = 0; i < 4; i++) rateLimit("d", 3, 60_000, t);
    resetRateLimit("d");
    assert.equal(rateLimit("d", 3, 60_000, t).ok, true);
  });
});

describe("clientIp", () => {
  const h = (o: Record<string, string>) => new Headers(o);
  test("uses the entry the nearest proxy appended, not a client-supplied one", () => {
    assert.equal(clientIp(h({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" })), "203.0.113.9");
  });
  test("single entry", () => assert.equal(clientIp(h({ "x-forwarded-for": "203.0.113.9" })), "203.0.113.9"));
  test("falls back to x-real-ip, then unknown", () => {
    assert.equal(clientIp(h({ "x-real-ip": "198.51.100.1" })), "198.51.100.1");
    assert.equal(clientIp(h({})), "unknown");
  });
});

describe("signupOpen", () => {
  test("the first account can always be created", () => {
    assert.equal(signupOpen({ allowSignup: "false", nodeEnv: "production", userCount: 0 }), true);
  });
  test("explicit true opens, explicit false closes", () => {
    assert.equal(signupOpen({ allowSignup: "true", nodeEnv: "production", userCount: 3 }), true);
    assert.equal(signupOpen({ allowSignup: "false", nodeEnv: "development", userCount: 3 }), false);
    assert.equal(signupOpen({ allowSignup: " FALSE ", nodeEnv: "development", userCount: 3 }), false);
  });
  test("unset: open in development, closed in production", () => {
    assert.equal(signupOpen({ nodeEnv: "development", userCount: 3 }), true);
    assert.equal(signupOpen({ nodeEnv: "production", userCount: 3 }), false);
  });
  test("an unrecognised value does not open a production server", () => {
    assert.equal(signupOpen({ allowSignup: "yes", nodeEnv: "production", userCount: 3 }), false);
  });
});
