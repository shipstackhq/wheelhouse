/**
 * Two guards on how the modules depend on each other. The import graph between modules must have no cycle: a cycle is what made a
 * test depend on which file it imported first ("Cannot access ... before initialization"), and only reading the imports catches it
 * reliably, since whether it bites depends on the order files happen to load. And every module's index.ts loads on its own, in a fresh
 * process, with no other module imported first.
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

/** The other modules a module's non-test code imports at runtime (`import type` is erased, so it is not an edge). */
function importsOf(name: string): Set<string> {
  const out = new Set<string>();
  const dir = path.join(here, name);
  const files = fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of src.matchAll(/^import\s+(?!type\s)[^;]*?from\s+"([^"]+)"|import\(\s*"([^"]+)"\s*\)/gm)) {
      const target = path.resolve(path.dirname(path.join(dir, f)), m[1] ?? m[2]);
      const rel = path.relative(here, target).split(path.sep);
      if (rel[0] !== ".." && rel[0] !== name && modules.includes(rel[0])) out.add(rel[0]);
    }
  }
  return out;
}

describe("modules depend on each other without a cycle", () => {
  test("the import graph between modules is acyclic", () => {
    const graph = new Map(modules.map((m) => [m, importsOf(m)]));
    const state = new Map<string, "open" | "done">();
    const visit = (m: string, trail: string[]) => {
      if (state.get(m) === "done") return;
      assert.notEqual(state.get(m), "open", `module cycle: ${[...trail, m].join(" -> ")}`);
      state.set(m, "open");
      for (const next of graph.get(m) ?? []) visit(next, [...trail, m]);
      state.set(m, "done");
    };
    for (const m of modules) visit(m, []);
  });
});

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
