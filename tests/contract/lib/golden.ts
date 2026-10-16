import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const DIR = path.join(import.meta.dirname, "..", "golden");

/**
 * Compare a value with the recorded one in golden/<name>.json. `UPDATE_GOLDEN=1` rewrites the file instead, so a deliberate
 * change to the contract is a visible diff in review, never a silent pass.
 */
export function expectGolden(name: string, value: unknown) {
  const file = path.join(DIR, `${name}.json`);
  const text = JSON.stringify(value, null, 2) + "\n";
  if (process.env.UPDATE_GOLDEN === "1") {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file, text);
    return;
  }
  assert.ok(fs.existsSync(file), `No golden file ${name}.json yet. Run with UPDATE_GOLDEN=1 to record it.`);
  assert.deepEqual(JSON.parse(text), JSON.parse(fs.readFileSync(file, "utf8")), `${name} no longer matches golden/${name}.json (UPDATE_GOLDEN=1 to accept a deliberate change)`);
}
