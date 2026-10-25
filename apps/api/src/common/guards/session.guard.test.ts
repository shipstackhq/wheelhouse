/** The guard's two rules (closed by default, @Public() opens a route). Runs on an in-memory PGlite: the session lookup goes through the booted app. */
process.env.PGLITE_DIR = "memory://";
delete process.env.DATABASE_URL;

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Controller, Get, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthError } from "../../modules/auth/auth-errors";
import { Public } from "../decorators/public.decorator";
import { SessionGuard } from "./session.guard";
import { testApp } from "../../test/app";
await testApp();

@Controller("x")
class Things {
  @Get("closed")
  closed() {}

  @Public()
  @Get("open")
  open() {}
}

const context = (handler: () => void) =>
  ({ getHandler: () => handler, getClass: () => Things, switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }) }) as unknown as ExecutionContext;
const guard = new SessionGuard(new Reflector());

describe("SessionGuard", () => {
  test("a route is closed by default: no session cookie is a 401", async () => {
    await assert.rejects(Promise.resolve(guard.canActivate(context(Things.prototype.closed))), (e: unknown) => e instanceof AuthError && e.status === 401);
  });

  test("a route marked @Public() lets a signed-out request through", async () => {
    assert.equal(await guard.canActivate(context(Things.prototype.open)), true);
  });
});
