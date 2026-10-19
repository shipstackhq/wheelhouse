import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ExecutionContext } from "@nestjs/common";
import { CsrfGuard } from "./endpoints";
import { ANONYMOUS_CSRF, CsrfError, csrfToken } from "./csrf";

/**
 * The guard on every /api/app controller, driven directly: it must read the method, the headers and the session cookie from
 * the request the way csrf.ts expects. (Over HTTP only POST and GET endpoints exist so far; this is where PUT, PATCH and
 * DELETE are held to the rule until an endpoint uses them.)
 */
const SESSION = "a-session-token";
const context = (method: string, headers: Record<string, string>) => ({ switchToHttp: () => ({ getRequest: () => ({ method, headers }) }) }) as unknown as ExecutionContext;
const guard = new CsrfGuard();
const valid = { host: "wh.example", origin: "https://wh.example", cookie: `a=1; wh_session=${SESSION}`, "x-csrf-token": csrfToken(SESSION) };

describe("CsrfGuard", () => {
  test("lets a same-site request with the session's token through, for every state-changing method", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal(guard.canActivate(context(m, valid)), true, m);
  });

  test("refuses PUT, PATCH, DELETE and POST from another site or without the token", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.throws(() => guard.canActivate(context(m, { ...valid, origin: "https://evil.example" })), (e: unknown) => e instanceof CsrfError && e.reason === "origin", `${m} from another site`);
      const { "x-csrf-token": _drop, ...noToken } = valid;
      void _drop;
      assert.throws(() => guard.canActivate(context(m, noToken)), (e: unknown) => e instanceof CsrfError && e.reason === "token", `${m} without a token`);
    }
  });

  test("never blocks a read", () => {
    assert.equal(guard.canActivate(context("GET", { host: "wh.example", origin: "https://evil.example" })), true);
  });

  test("before sign-in only the anonymous token works, and with a session cookie it does not", () => {
    const anon = { host: "wh.example", origin: "https://wh.example", "x-csrf-token": ANONYMOUS_CSRF };
    assert.equal(guard.canActivate(context("POST", anon)), true);
    assert.throws(() => guard.canActivate(context("POST", { ...anon, cookie: `wh_session=${SESSION}` })), CsrfError);
  });

  test("reads an Array header (Node joins none for these) and a Referer when there is no Origin", () => {
    const ctx = { switchToHttp: () => ({ getRequest: () => ({ method: "POST", headers: { host: "wh.example", referer: "https://wh.example/t/WH", "x-csrf-token": [ANONYMOUS_CSRF] } }) }) } as unknown as ExecutionContext;
    assert.equal(guard.canActivate(ctx), true);
  });
});
