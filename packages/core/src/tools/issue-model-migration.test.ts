import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { migrationsFolder } from "../db";
import { migrationsThrough } from "./db-copy";

// Migration 0031 lets statuses share a role (one of them its default), adds a canceled status to every team, makes status names
// unique per team, adds sub-issues, and makes "none" the priority of a new issue. This runs it over awkward data made the old way.

test("existing statuses become their roles' defaults, every team gets a canceled one, names are made unique, old priorities stay", async () => {
  const client = new PGlite();
  await migrate(drizzle(client) as never, { migrationsFolder: migrationsThrough("0030") });
  const q = async (text: string) => (await client.query(text)).rows as Record<string, unknown>[];
  try {
    await q(`insert into workspaces (name) values ('W')`);
    await q(`insert into teams (workspace_id, key, name) select id, k, k from workspaces, (values ('AA'), ('BB'), ('CC')) t(k)`);
    // AA: the standard board. BB: a custom status already called "Cancelled", and two statuses whose names differ only in case.
    // CC: a status already called "Canceled" that has a role (an odd board), so the new one cannot take that name.
    for (const [role, name, pos] of [["backlog", "Backlog", 1], ["todo", "Todo", 2], ["done", "Done", 3]] as const) {
      await q(`insert into statuses (team_id, workspace_id, name, position, role) select id, workspace_id, '${name}', ${pos}, '${role}' from teams where key = 'AA'`);
    }
    await q(`insert into statuses (team_id, workspace_id, name, position, role) select id, workspace_id, 'Todo', 1, 'todo' from teams where key = 'BB'`);
    await q(`insert into statuses (team_id, workspace_id, name, position) select id, workspace_id, 'todo', 2 from teams where key = 'BB'`);
    await q(`insert into statuses (team_id, workspace_id, name, position) select id, workspace_id, 'Cancelled', 3 from teams where key = 'BB'`);
    await q(`insert into statuses (team_id, workspace_id, name, position, role) select id, workspace_id, 'Canceled', 1, 'done' from teams where key = 'CC'`);
    await q(`insert into issues (team_id, workspace_id, status_id, number, title, position, created_by_kind, priority) select team_id, workspace_id, id, 1, 'old', 1, 'human', 'medium' from statuses where name = 'Backlog'`);

    await migrate(drizzle(client) as never, { migrationsFolder: migrationsThrough("0031") });

    const byTeam = async (key: string) => await q(`select s.name, s.role, s.is_default from statuses s join teams t on t.id = s.team_id where t.key = '${key}' order by s.position, s.id`);
    assert.deepEqual(await byTeam("AA"), [
      { name: "Backlog", role: "backlog", is_default: true },
      { name: "Todo", role: "todo", is_default: true },
      { name: "Done", role: "done", is_default: true },
      { name: "Canceled", role: "canceled", is_default: true },
    ], "each existing role-holding status is its default, and the team gets a canceled one at the end");
    assert.deepEqual(await byTeam("BB"), [
      { name: "Todo", role: "todo", is_default: true },
      { name: "todo (2)", role: null, is_default: false },
      { name: "Cancelled", role: "canceled", is_default: true },
    ], "the second 'todo' is renamed, and a custom status already called Cancelled becomes the canceled one");
    assert.deepEqual(await byTeam("CC"), [
      { name: "Canceled", role: "done", is_default: true },
      { name: "Canceled (status)", role: "canceled", is_default: true },
    ], "a new canceled status takes another name when its name is taken");

    assert.deepEqual(await q(`select priority from issues`), [{ priority: "medium" }], "an existing priority is kept");
    await q(`insert into issues (team_id, workspace_id, status_id, number, title, position, created_by_kind) select team_id, workspace_id, id, 2, 'new', 2, 'human' from statuses where name = 'Backlog'`);
    assert.deepEqual(await q(`select priority from issues where number = 2`), [{ priority: "none" }], "a new issue starts with no priority");
    assert.deepEqual(await q(`select parent_id from issues where number = 1`), [{ parent_id: null }]);
  } finally {
    await client.close();
  }
});

test("a parent is in the issue's team, and deleting it sets its sub-issues free without touching their team", async () => {
  const client = new PGlite();
  await migrate(drizzle(client) as never, { migrationsFolder: migrationsFolder() });
  const q = async (text: string) => (await client.query(text)).rows as Record<string, unknown>[];
  try {
    await q(`insert into workspaces (name) values ('W')`);
    await q(`insert into teams (workspace_id, key, name) select id, k, k from workspaces, (values ('AA'), ('BB')) t(k)`);
    await q(`insert into statuses (team_id, workspace_id, name, position, role) select id, workspace_id, 'Todo', 1, 'todo' from teams`);
    const add = (key: string, n: number, parent?: string) => q(`insert into issues (team_id, workspace_id, status_id, number, title, position, created_by_kind${parent ? ", parent_id" : ""}) select s.team_id, s.workspace_id, s.id, ${n}, 'i${n}', 1, 'human'${parent ? `, (select id from issues where title = '${parent}')` : ""} from statuses s join teams t on t.id = s.team_id where t.key = '${key}'`);
    await add("AA", 1);
    await add("AA", 2, "i1");
    await assert.rejects(add("BB", 3, "i1"), /issues_parent_fk/, "a parent of another team is refused by the key");
    await q(`delete from issues where title = 'i1'`);
    assert.deepEqual(await q(`select i.parent_id, t.key from issues i join teams t on t.id = i.team_id`), [{ parent_id: null, key: "AA" }], "the child is kept, free, and still in AA");
  } finally {
    await client.close();
  }
});
