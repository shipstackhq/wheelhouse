/**
 * The migration journal itself. Drizzle applies only migrations whose `when` is later than the last one applied, so an entry dated
 * before an earlier one is skipped on every existing database while the log still says "Migrations applied" (0055 and 0056 were).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle");
const journal = JSON.parse(fs.readFileSync(path.join(dir, "meta", "_journal.json"), "utf8")) as { entries: { idx: number; when: number; tag: string }[] };

describe("migration journal", () => {
  test("every migration is dated after the one before it, in order, with its file present", () => {
    journal.entries.forEach((e, i) => {
      assert.equal(e.idx, i, `${e.tag} is out of order`);
      assert.ok(fs.existsSync(path.join(dir, `${e.tag}.sql`)), `${e.tag}.sql is missing`);
      if (i) assert.ok(e.when > journal.entries[i - 1].when, `${e.tag} is dated before ${journal.entries[i - 1].tag}: drizzle would skip it on existing databases`);
    });
  });
});
