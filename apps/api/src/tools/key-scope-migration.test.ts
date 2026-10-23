import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { migrationsFolder } from "../db";
import { migrationsThrough } from "./db-copy";

// Migration 0026 scopes agent keys to teams. Every key that existed must keep every team of its own workspace, on the day.

test("existing keys, revoked ones too, are given every team of their own workspace and nothing of another", async () => {
  const client = new PGlite();
  const q = async (text: string) => (await client.query(text)).rows as Record<string, unknown>[];
  try {
    await migrate(drizzle(client) as never, { migrationsFolder: migrationsThrough("0025") });
    await q(`insert into workspaces (name) values ('W1'), ('W2'), ('W3')`);
    await q(`insert into teams (workspace_id, key, name) select id, case name when 'W1' then 'AA' when 'W2' then 'BB' else 'CC' end, 'T' from workspaces where name <> 'W3'`);
    await q(`insert into teams (workspace_id, key, name) select id, 'AB', 'T2' from workspaces where name = 'W1'`);
    await q(`insert into api_keys (workspace_id, name, prefix, key_hash, revoked_at) select id, 'k-' || name, 'wh_', 'h-' || name, case name when 'W1' then now() end from workspaces`);
    await q(`insert into api_keys (workspace_id, name, prefix, key_hash) select id, 'k2-' || name, 'wh_', 'h2-' || name from workspaces where name = 'W1'`);

    await migrate(drizzle(client) as never, { migrationsFolder: migrationsFolder() });

    const rows = await q(`select k.name as key, t.key as team from api_key_teams a join api_keys k on k.id = a.api_key_id join teams t on t.id = a.team_id order by k.name, t.key`);
    assert.deepEqual(rows.map((r) => `${r.key}:${r.team}`), ["k-W1:AA", "k-W1:AB", "k-W2:BB", "k2-W1:AA", "k2-W1:AB"], "a workspace with no team gives its key none, and no key crosses a workspace");
    assert.deepEqual(await q(`select count(*)::int as n from api_key_teams a join api_keys k on k.id = a.api_key_id where k.workspace_id <> a.workspace_id`), [{ n: 0 }]);
  } finally {
    await client.close();
  }
});
