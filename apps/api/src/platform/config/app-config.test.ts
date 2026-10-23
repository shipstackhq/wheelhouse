import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { AppConfig } from "./app-config";

const saved = { ...process.env };

describe("AppConfig", () => {
  afterEach(() => {
    for (const k of ["DATABASE_URL", "PGLITE_DIR", "WHEELHOUSE_MIGRATIONS_DIR"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("reads the environment when used, so it answers what core reads", () => {
    const config = new AppConfig();
    delete process.env.DATABASE_URL;
    assert.equal(config.databaseUrl, undefined);
    process.env.DATABASE_URL = "postgres://example/wh";
    assert.equal(config.databaseUrl, "postgres://example/wh");
  });

  test("the paths are the ones configureEnvironment sets", () => {
    process.env.PGLITE_DIR = "/tmp/x";
    process.env.WHEELHOUSE_MIGRATIONS_DIR = "/tmp/y";
    const config = new AppConfig();
    assert.equal(config.pgliteDir, "/tmp/x");
    assert.equal(config.migrationsDir, "/tmp/y");
    assert.ok(config.repoRoot.endsWith("wheelhouse"), config.repoRoot);
  });
});
