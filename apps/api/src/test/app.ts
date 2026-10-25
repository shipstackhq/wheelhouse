import "reflect-metadata";
import type { INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

let booted: Promise<INestApplicationContext> | undefined;

/**
 * The real providers, booted once per test file, over the database the test chose (`PGLITE_DIR=memory://`, set before anything
 * is imported). An application context, not a server: no port, no HTTP. Module `onModuleInit` hooks run, which is what points the
 * converted modules' shims at the live services. Take a service with `(await testApp()).get(TeamsService)`.
 *
 * Call it as `await testApp();` at the top level of a test file (after the imports), not inside `before`: node:test starts a root-level
 * `before` hook the moment it is registered, so a second `before` that uses a shim would run while the first is still booting.
 * Everything is imported when first called, so the test's own environment settings are in place first. The `api` role is
 * loaded: the daemon's sweep timer belongs to the `daemon` role and would keep the test process alive.
 */
export function testApp(): Promise<INestApplicationContext> {
  booted ??= (async () => {
    process.env.SERVICE_ROLE = "api";
    const { AppModule } = await import("../app.module");
    return NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false });
  })();
  return booted;
}
