import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/**
 * docs/ui-api.md carries the inventory of the server actions that the web app's API replaces (WH-93). Every exported
 * action has exactly one row with an owner, so none is forgotten when the Next app goes.
 */
const OWNERS = ["WH-93", "WH-95", "WH-96", "WH-97", "WH-98", "unneeded"];

describe("the server action inventory", () => {
  const doc = fs.readFileSync("docs/ui-api.md", "utf8");
  const actions = [...fs.readFileSync("src/app/actions.ts", "utf8").matchAll(/^export async function (\w+)/gm)].map((m) => m[1]);
  const rows = [...doc.matchAll(/^\| `(\w+)` \| (.+?) \| (\S+) \| (.*) \|$/gm)].map((m) => ({ action: m[1], endpoint: m[2], owner: m[3] }));

  test("every exported server action has a row", () => {
    const missing = actions.filter((a) => !rows.some((r) => r.action === a));
    assert.deepEqual(missing, [], `server actions without a row in docs/ui-api.md: ${missing.join(", ")}`);
  });

  test("there is no row for an action that does not exist, and none is listed twice", () => {
    const stale = rows.filter((r) => !actions.includes(r.action)).map((r) => r.action);
    assert.deepEqual(stale, [], `rows for actions that are gone: ${stale.join(", ")}`);
    const names = rows.map((r) => r.action);
    assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), []);
  });

  test("every row has a known owner ticket, and an endpoint unless it is unneeded", () => {
    for (const r of rows) {
      assert.ok(OWNERS.includes(r.owner), `${r.action}: owner "${r.owner}"`);
      if (r.owner === "unneeded") assert.equal(r.endpoint, "none", r.action);
      else assert.match(r.endpoint, /^`(GET|POST|PUT|PATCH|DELETE) \/api\/app\/[^`]+`$/, r.action);
    }
  });

  test("there are 59 actions, and the ones already built point at routes that exist", () => {
    assert.equal(actions.length, 59);
    const built = rows.filter((r) => r.owner === "WH-93");
    assert.deepEqual(built.map((r) => r.action).sort(), ["login", "logout", "signup"]);
  });
});
