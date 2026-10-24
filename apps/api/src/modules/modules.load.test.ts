/**
 * Every module's index.ts loads on its own, in a fresh process, with no other module imported first. A module cycle shows up as a
 * "Cannot access ... before initialization" error that depends on which file loads first; one process per module catches it whichever
 * door a caller comes in by, so no test needs an import-order trick.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = import.meta.dirname;
const modules = fs.readdirSync(here, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(here, d.name, "index.ts"))).map((d) => d.name);

describe("each module's index.ts loads alone", () => {
  assert.ok(modules.length >= 8, "the modules were found");
  for (const name of modules) {
    test(name, async () => {
      const file = path.join(here, name, "index.ts");
      // In-memory database and no DATABASE_URL, as every test that could touch one does.
      const env = { ...process.env, PGLITE_DIR: "memory://", DATABASE_URL: "" };
      delete (env as Record<string, string | undefined>).DATABASE_URL;
      await run(process.execPath, ["--import", "tsx", "-e", `await import(${JSON.stringify(file)})`], { env, cwd: path.join(here, "../..") });
    });
  }
});
