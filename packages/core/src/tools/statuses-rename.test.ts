import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { migrationsThrough } from "./db-copy";

// Migration 0030 renames a board column to a status in place. This runs it over a database with columns, issues in them, and an
// event that recorded the column an issue was created in, and checks that nothing was lost.

test("columns become statuses with their roles, issues and the status logged when an issue was created", async () => {
  const client = new PGlite();
  await migrate(drizzle(client) as never, { migrationsFolder: migrationsThrough("0029") });
  const q = async (text: string) => (await client.query(text)).rows as Record<string, unknown>[];
  try {
    await q(`insert into workspaces (name) values ('W')`);
    await q(`insert into teams (workspace_id, key, name) select id, 'AA', 'T' from workspaces`);
    await q(`insert into columns (team_id, workspace_id, name, position, role) select id, workspace_id, 'Todo', 1, 'todo' from teams`);
    await q(`insert into columns (team_id, workspace_id, name, position) select id, workspace_id, 'Blocked', 2 from teams`);
    await q(`insert into issues (team_id, workspace_id, column_id, number, title, position, created_by_kind) select team_id, workspace_id, id, 1, 'one', 1, 'human' from columns where name = 'Todo'`);
    await q(`insert into events (workspace_id, team_id, actor_kind, actor_name, type, entity, entity_id, summary, data) select workspace_id, team_id, 'human', 'x', 'issue.created', 'issue', id, 'AA-1 created', '{"ref": "AA-1", "column": "Todo", "title": "one"}'::jsonb from issues`);
    await q(`insert into events (workspace_id, team_id, actor_kind, actor_name, type, entity, entity_id, summary, data) select workspace_id, team_id, 'human', 'x', 'issue.moved', 'issue', id, 'moved', '{"from": "Todo", "to": "Blocked"}'::jsonb from issues`);

    await migrate(drizzle(client) as never, { migrationsFolder: migrationsThrough("0030") });

    assert.deepEqual(await q(`select name, role from statuses order by position`), [{ name: "Todo", role: "todo" }, { name: "Blocked", role: null }]);
    assert.deepEqual(await q(`select s.name from issues i join statuses s on s.id = i.status_id`), [{ name: "Todo" }], "the issue keeps its status");
    assert.deepEqual(await q(`select data from events where type = 'issue.created'`), [{ data: { ref: "AA-1", status: "Todo", title: "one" } }], "the key is renamed, the rest is kept");
    assert.deepEqual(await q(`select data from events where type = 'issue.moved'`), [{ data: { from: "Todo", to: "Blocked" } }], "other events are not touched");
    assert.deepEqual(await q(`select 1 from information_schema.tables where table_schema = 'public' and table_name = 'columns'`), []);
    assert.deepEqual(await q(`select conname from pg_constraint where connamespace = 'public'::regnamespace and conname like 'columns\\_%' and conname not like '%\\_not\\_null'`), []);
    assert.deepEqual(await q(`select indexname from pg_indexes where schemaname = 'public' and indexname like 'columns\\_%'`), []);
    // one status per role per team still holds under its new name
    await assert.rejects(q(`insert into statuses (team_id, workspace_id, name, position, role) select team_id, workspace_id, 'Todo 2', 3, 'todo' from statuses limit 1`), /statuses_team_role_idx/);
  } finally {
    await client.close();
  }
});
