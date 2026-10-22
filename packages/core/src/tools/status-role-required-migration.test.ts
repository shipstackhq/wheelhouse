import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { migrationsThrough } from "./db-copy";

// Migration 0033 makes a status's role required. The statuses that had none take the role of the nearest status before them, else the
// first one; nothing moves, nothing becomes a default, and a status without a role is refused from then on.

test("role-less statuses take the role before them (or the first), keep their place, are not defaults, and a role is required after", async () => {
  const client = new PGlite();
  await migrate(drizzle(client) as never, { migrationsFolder: migrationsThrough("0032") });
  const q = async (text: string) => (await client.query(text)).rows as Record<string, unknown>[];
  try {
    await q(`insert into workspaces (name) values ('W')`);
    await q(`insert into teams (workspace_id, key, name) select id, k, k from workspaces, (values ('AA'), ('BB'), ('CC')) t(k)`);
    const add = (team: string, name: string, position: number, role: string | null, isDefault = false) =>
      q(`insert into statuses (team_id, workspace_id, name, position, role, is_default) select id, workspace_id, '${name}', ${position}, ${role ? `'${role}'` : "null"}, ${isDefault} from teams where key = '${team}'`);
    // AA: Backlog, Todo, Blocked (none), In Progress, Done, Waiting (none, after the last), Canceled
    for (const [n, p, r] of [["Backlog", 1, "backlog"], ["Todo", 2, "todo"], ["Blocked", 3, null], ["In Progress", 4, "in_progress"], ["Done", 5, "done"], ["Waiting", 6, null], ["Canceled", 7, "canceled"]] as const) await add("AA", n, p, r, r !== null);
    // BB: a role-less status ahead of every other one
    for (const [n, p, r] of [["Inbox", 0, null], ["Backlog", 1, "backlog"], ["Done", 2, "done"]] as const) await add("BB", n, p, r, r !== null);
    // CC: two role-less statuses in a row
    for (const [n, p, r] of [["Todo", 1, "todo"], ["Blocked", 2, null], ["Stuck", 3, null], ["Done", 4, "done"]] as const) await add("CC", n, p, r, r !== null);

    await migrate(drizzle(client) as never, { migrationsFolder: migrationsThrough("0033") });

    const of = async (key: string) => await q(`select s.name, s.role, s.is_default from statuses s join teams t on t.id = s.team_id where t.key = '${key}' order by s.position`);
    assert.deepEqual(await of("AA"), [
      { name: "Backlog", role: "backlog", is_default: true }, { name: "Todo", role: "todo", is_default: true },
      { name: "Blocked", role: "todo", is_default: false }, { name: "In Progress", role: "in_progress", is_default: true },
      { name: "Done", role: "done", is_default: true }, { name: "Waiting", role: "done", is_default: false }, { name: "Canceled", role: "canceled", is_default: true },
    ]);
    assert.deepEqual((await of("BB")).map((r) => [r.name, r.role, r.is_default]), [["Inbox", "backlog", false], ["Backlog", "backlog", true], ["Done", "done", true]], "ahead of everything: the first role");
    assert.deepEqual((await of("CC")).map((r) => [r.name, r.role]), [["Todo", "todo"], ["Blocked", "todo"], ["Stuck", "todo"], ["Done", "done"]], "a run of them all take the same role");

    // the roles are in one run each, in the order of the roles, on every team
    const order = ["backlog", "todo", "in_progress", "review", "done", "canceled"];
    for (const key of ["AA", "BB", "CC"]) {
      const ranks = (await of(key)).map((r) => order.indexOf(String(r.role)));
      assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), `${key} stays grouped by role`);
    }
    assert.deepEqual(await q(`select count(*)::int as n from statuses where role is null`), [{ n: 0 }]);
    await assert.rejects(q(`insert into statuses (team_id, workspace_id, name, position) select id, workspace_id, 'x', 99 from teams where key = 'AA'`), /null value in column "role"/);
    assert.deepEqual(await q(`select conname from pg_constraint where conname = 'statuses_default_has_role_check'`), [], "the check that needed a role is gone with the nullable column");
  } finally {
    await client.close();
  }
});
