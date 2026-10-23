import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { migrationsThrough } from "./db-copy";

// Migration 0029 renames tickets to issues in place. This runs it over a database that has tickets, a label on one, and the
// change logs, and checks that nothing was lost and that the words the logs stored were rewritten.

test("tickets become issues with their data, labels, counter and logged event types", async () => {
  const client = new PGlite();
  await migrate(drizzle(client) as never, { migrationsFolder: migrationsThrough("0028") });
  const q = async (text: string) => (await client.query(text)).rows as Record<string, unknown>[];
  try {
    await q(`insert into workspaces (name) values ('W')`);
    await q(`insert into teams (workspace_id, key, name, ticket_counter) select id, 'AA', 'T', 7 from workspaces`);
    await q(`insert into columns (team_id, workspace_id, name, position) select id, workspace_id, 'Todo', 1 from teams`);
    await q(`insert into tickets (team_id, workspace_id, column_id, number, title, position, created_by_kind) select team_id, workspace_id, id, 7, 'seven', 1, 'human' from columns`);
    await q(`insert into labels (team_id, workspace_id, name) select team_id, workspace_id, 'Bug' from columns`);
    await q(`insert into ticket_labels (ticket_id, label_id, team_id, workspace_id) select t.id, l.id, t.team_id, t.workspace_id from tickets t join labels l on l.team_id = t.team_id`);
    await q(`insert into events (workspace_id, team_id, actor_kind, actor_name, type, entity, entity_id, summary) select workspace_id, team_id, 'human', 'x', 'ticket.created', 'ticket', id, 'AA-7 created' from tickets`);
    await q(`insert into events (workspace_id, team_id, actor_kind, actor_name, type, entity, entity_id, summary) select workspace_id, team_id, 'human', 'x', 'node.updated', 'node', id, 'a node' from tickets`);
    await q(`insert into workspace_events (workspace_id, actor_kind, actor_name, type, entity, entity_id, summary) select workspace_id, 'human', 'x', 'project.ticket_joined', 'project', id, 'AA-7 joined' from tickets`);

    await migrate(drizzle(client) as never, { migrationsFolder: migrationsThrough("0029") });

    assert.deepEqual(await q(`select title, number from issues`), [{ title: "seven", number: 7 }]);
    assert.deepEqual(await q(`select issue_counter from teams`), [{ issue_counter: 7 }], "the counter keeps its value");
    assert.deepEqual(await q(`select l.name from issue_labels il join issues i on i.id = il.issue_id join labels l on l.id = il.label_id`), [{ name: "Bug" }]);
    assert.deepEqual((await q(`select type, entity from events order by seq`)), [{ type: "issue.created", entity: "issue" }, { type: "node.updated", entity: "node" }]);
    assert.deepEqual(await q(`select type from workspace_events`), [{ type: "project.issue_joined" }]);
    assert.deepEqual(await q(`select 1 from information_schema.tables where table_schema = 'public' and table_name in ('tickets', 'ticket_labels', 'ticket_nodes', 'pull_request_tickets')`), []);
    assert.deepEqual(await q(`select conname from pg_constraint where connamespace = 'public'::regnamespace and conname like '%ticket%' and conname not like '%\\_not\\_null'`), [], "no key keeps the old name");
    assert.deepEqual(await q(`select indexname from pg_indexes where schemaname = 'public' and indexname like '%ticket%'`), []);

    // workspace_events is append-only again after the rewrite.
    await assert.rejects(q(`update workspace_events set summary = 'changed'`), /append-only/);
  } finally {
    await client.close();
  }
});
