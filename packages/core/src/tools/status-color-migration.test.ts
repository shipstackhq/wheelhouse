import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { migrationsThrough } from "./db-copy";

// Migration 0032 gives a status a colour and stops deleting a status from deleting its issues: before it, the foreign key cascaded.

test("a status gets a colour (null for the ones that exist), and a status with issues can no longer be deleted", async () => {
  const client = new PGlite();
  await migrate(drizzle(client) as never, { migrationsFolder: migrationsThrough("0031") });
  const q = async (text: string) => (await client.query(text)).rows as Record<string, unknown>[];
  try {
    await q(`insert into workspaces (name) values ('W')`);
    await q(`insert into teams (workspace_id, key, name) select id, 'AA', 'T' from workspaces`);
    await q(`insert into statuses (team_id, workspace_id, name, position, role, is_default) select id, workspace_id, 'Todo', 1, 'todo', true from teams`);
    await q(`insert into issues (team_id, workspace_id, status_id, number, title, position, created_by_kind) select team_id, workspace_id, id, 1, 'kept', 1, 'human' from statuses`);
    // before: deleting the status took the issue with it
    await q(`begin`);
    await q(`delete from statuses`);
    assert.deepEqual(await q(`select count(*)::int as n from issues`), [{ n: 0 }], "0031: the issue is deleted with its status");
    await q(`rollback`);

    await migrate(drizzle(client) as never, { migrationsFolder: migrationsThrough("0032") });

    assert.deepEqual(await q(`select name, color from statuses`), [{ name: "Todo", color: null }]);
    await assert.rejects(q(`delete from statuses`), /violates foreign key constraint "issues_status_id_statuses_id_fk"/);
    assert.deepEqual(await q(`select count(*)::int as n from issues`), [{ n: 1 }], "0032: the issue is kept");
    await assert.rejects(q(`update statuses set color = 'pink'`), /statuses_color_check/);
    await q(`update statuses set color = 'violet'`);
    // a team's deletion still removes its statuses and issues together
    await q(`delete from teams`);
    assert.deepEqual(await q(`select (select count(*)::int from statuses) as s, (select count(*)::int from issues) as i`), [{ s: 0, i: 0 }]);
  } finally {
    await client.close();
  }
});
