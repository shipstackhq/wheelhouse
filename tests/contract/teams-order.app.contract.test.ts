import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { anon, app, newAccount } from "./lib/app";

/** The order a person keeps their teams in (PUT /api/app/teams/order): theirs alone, remembered by the list. */

let k = 0;
const newKey = () => `O${Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 3).toUpperCase()}${String.fromCharCode(65 + (k++ % 26))}`;

describe("PUT /api/app/teams/order", () => {
  test("signed out is a 401; a bad body is a 400 naming keys", async () => {
    const { sess } = await newAccount("Owner");
    assert.equal((await app("PUT", "/api/app/teams/order", anon(), { body: { keys: [] } })).status, 401);
    const bad = await app("PUT", "/api/app/teams/order", sess, { body: { keys: "AA" } });
    assert.equal(bad.status, 400, bad.text);
    assert.ok(bad.json.error.details?.fields?.keys);
  });

  test("the list comes back in the order set; keys that are not yours are ignored; another person's list is untouched", async () => {
    const owner = (await newAccount("Owner")).sess;
    const other = await newAccount("Other");
    const [a, b, c] = [newKey(), newKey(), newKey()];
    for (const key of [a, b, c]) assert.equal((await app("POST", "/api/app/teams", owner, { body: { name: `Team ${key}`, key } })).status, 201);
    const otherKey = newKey();
    assert.equal((await app("POST", "/api/app/teams", other.sess, { body: { name: "Theirs", key: otherKey } })).status, 201);
    const list = async () => ((await app("GET", "/api/app/teams", owner)).json.teams as { key: string }[]).map((t) => t.key);
    assert.deepEqual(await list(), [a, b, c], "oldest first until ordered");
    const set = await app("PUT", "/api/app/teams/order", owner, { body: { keys: [c, a, otherKey, "NOPE", b] } });
    assert.equal(set.status, 200, set.text);
    assert.equal(set.json.placed, 3, "another workspace's team and an unknown key are ignored");
    assert.deepEqual(await list(), [c, a, b]);
    assert.equal((await app("GET", "/api/app/teams", other.sess)).json.teams.length, 1);
    assert.deepEqual((await app("GET", "/api/app/teams", other.sess)).json.teams.map((t: { key: string }) => t.key), [otherKey], "nothing changed for them");
  });
});
