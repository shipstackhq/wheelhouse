import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { migrationsFolder } from "../db";
import { migrationsThrough } from "./db-copy";

// Migration 0022 turns decisions.node_ids, invites.teams and tickets.labels into rows. This runs it over a database made the old way.

async function oldDb() {
  const client = new PGlite();
  await migrate(drizzle(client) as never, { migrationsFolder: migrationsThrough("0021") });
  const q = async (text: string) => (await client.query(text)).rows as Record<string, unknown>[];
  await q(`insert into workspaces (name) values ('W1'), ('W2')`);
  await q(`insert into teams (workspace_id, key, name) select id, case name when 'W1' then 'AA' else 'BB' end, 'T' from workspaces`);
  await q(`insert into teams (workspace_id, key, name) select id, 'AC', 'T2' from workspaces where name = 'W1'`);
  await q(`insert into columns (team_id, workspace_id, name, position) select id, workspace_id, 'Todo', 1 from teams`);
  await q(`insert into nodes (team_id, workspace_id, layer, kind, name) select id, workspace_id, 'system', 'service', 'n-' || key from teams`);
  const nodes = Object.fromEntries((await q(`select t.key, n.id from nodes n join teams t on t.id = n.team_id`)).map((r) => [r.key, r.id]));
  const teamIds = Object.fromEntries((await q(`select key, id from teams`)).map((r) => [r.key, r.id]));
  return { client, q, nodes, teamIds };
}
const finish = (client: PGlite) => migrate(drizzle(client) as never, { migrationsFolder: migrationsFolder() });

test("the arrays become rows: decision nodes, invite teams and ticket labels (merged by name, trimmed)", async () => {
  const { client, q, nodes, teamIds } = await oldDb();
  try {
    await q(`insert into decisions (team_id, workspace_id, number, title, author_kind, author_name, node_ids) select id, workspace_id, 1, 'D1', 'human', 'x', '["${nodes.AA}", "${String(nodes.AA).toUpperCase()}"]'::jsonb from teams where key = 'AA'`);
    await q(`insert into decisions (team_id, workspace_id, number, title, author_kind, author_name) select id, workspace_id, 2, 'D2 none', 'human', 'x' from teams where key = 'AA'`);
    await q(`insert into invites (kind, email, workspace_id, token_hash, expires_at, teams) select 'join_workspace', 'a@x.io', id, 'tok1', now(), '[{"teamId": "${teamIds.AA}", "role": "editor"}, {"teamId": "${teamIds.AC}", "role": "viewer"}, {"teamId": "${teamIds.AA}", "role": "admin"}]'::jsonb from workspaces where name = 'W1'`);
    await q(`insert into invites (kind, email, token_hash, expires_at) values ('new_workspace', 'n@x.io', 'tok2', now())`);
    await q(`insert into tickets (team_id, workspace_id, column_id, number, title, position, created_by_kind, labels) select t.team_id, t.workspace_id, t.id, 1, 'one', 1, 'human', '["Bug", " bug ", "UI  polish", "", "api"]'::jsonb from columns t join teams x on x.id = t.team_id where x.key = 'AA'`);
    await q(`insert into tickets (team_id, workspace_id, column_id, number, title, position, created_by_kind, labels) select t.team_id, t.workspace_id, t.id, 2, 'two', 2, 'human', '["BUG"]'::jsonb from columns t join teams x on x.id = t.team_id where x.key = 'AA'`);
    await q(`insert into tickets (team_id, workspace_id, column_id, number, title, position, created_by_kind, labels) select t.team_id, t.workspace_id, t.id, 1, 'other team', 1, 'human', '["bug"]'::jsonb from columns t join teams x on x.id = t.team_id where x.key = 'BB'`);

    await finish(client);

    assert.deepEqual(await q(`select count(*)::int as n from decision_nodes`), [{ n: 1 }], "a repeated id is one link");
    assert.deepEqual(await q(`select role, k.key from invite_teams i join teams k on k.id = i.team_id order by k.key`), [{ role: "editor", key: "AA" }, { role: "viewer", key: "AC" }], "a team listed twice is one row (the first entry)");
    assert.deepEqual(await q(`select count(*)::int as n from invite_teams i join invites v on v.id = i.invite_id where v.kind = 'new_workspace'`), [{ n: 0 }]);
    assert.deepEqual((await q(`select l.name from labels l join teams t on t.id = l.team_id where t.key = 'AA' order by lower(l.name)`)).map((r) => r.name), ["api", "Bug", "UI polish"], "one label per name in any case, first spelling wins, no empty one");
    assert.deepEqual((await q(`select t.title, l.name from issue_labels tl join issues t on t.id = tl.issue_id join labels l on l.id = tl.label_id order by t.title, lower(l.name)`)).map((r) => `${r.title}:${r.name}`), ["one:api", "one:Bug", "one:UI polish", "other team:bug", "two:Bug"]);
    assert.deepEqual(await q(`select count(*)::int as n from labels`), [{ n: 4 }], "the same name in two teams is two labels");
    for (const [table, column] of [["decisions", "node_ids"], ["invites", "teams"], ["issues", "labels"]]) {
      assert.deepEqual(await q(`select 1 from information_schema.columns where table_name = '${table}' and column_name = '${column}'`), [], `${table}.${column} is gone`);
    }
  } finally {
    await client.close();
  }
});

test("a dangling reference stops the migration with nothing changed, and says what to do", async () => {
  const { client, q, nodes, teamIds } = await oldDb();
  try {
    // A decision naming a node of another team, and an invite granting a team of another workspace.
    await q(`insert into decisions (team_id, workspace_id, number, title, author_kind, author_name, node_ids) select id, workspace_id, 1, 'D', 'human', 'x', '["${nodes.BB}"]'::jsonb from teams where key = 'AA'`);
    await q(`insert into invites (kind, email, workspace_id, token_hash, expires_at, teams) select 'join_workspace', 'a@x.io', id, 'tok', now(), '[{"teamId": "${teamIds.BB}", "role": "editor"}]'::jsonb from workspaces where name = 'W1'`);
    await assert.rejects(finish(client), (e: unknown) => /WH-115: 1 decision node id\(s\), 1 invite team\(s\) and 0 ticket label\(s\).*db:preflight/s.test(String((e as { cause?: { message?: string } }).cause?.message)));
    assert.deepEqual(await q(`select count(*)::int as n from information_schema.tables where table_name = 'labels'`), [{ n: 0 }], "the whole migration was rolled back");
    assert.deepEqual(await q(`select jsonb_array_length(node_ids)::int as n from decisions`), [{ n: 1 }], "the data is as it was");
  } finally {
    await client.close();
  }
});
