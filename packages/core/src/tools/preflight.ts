import { getTableConfig, type PgColumn, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "../db/schema";
import type { Finding, Q } from "./db-copy";

/**
 * What a database must satisfy before migrations 0021 (WH-114: the unique keys, the parent keys and a CHECK for every enum
 * column) and 0022 (WH-115: no id or name in a JSON array that points at nothing) can be applied. It only reads, and it lists
 * the rows that would make a migration fail so they can be fixed by hand first (never by dropping them). Run it on a copy
 * brought to the migration just before 0021:
 *   pnpm db:migrate --to <copy> --through 0020 && pnpm db:preflight --to <copy>
 * The enum checks come from the same TypeScript enums the migration's CHECK constraints are made from.
 */

const qi = (name: string) => `"${name.replaceAll('"', '""')}"`;
const lit = (v: string) => `'${v.replaceAll("'", "''")}'`;
const SAMPLE = 5;

const isTable = (t: unknown): t is PgTable => {
  try {
    return getTableConfig(t as PgTable).name !== undefined;
  } catch {
    return false;
  }
};

const enumColumns = () => {
  const out: { table: string; column: string; values: string[] }[] = [];
  for (const t of Object.values(schema)) {
    if (!isTable(t)) continue;
    const cfg = getTableConfig(t);
    for (const c of cfg.columns as PgColumn[]) if (Array.isArray(c.enumValues) && c.enumValues.length) out.push({ table: cfg.name, column: c.name, values: [...c.enumValues] });
  }
  return out.sort((a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column));
};

async function present(q: Q, table: string, column?: string) {
  const [r] = await q(
    `select count(*)::int as n from information_schema.columns where table_schema = 'public' and table_name = $1 ${column ? "and column_name = $2" : ""}`,
    column ? [table, column] : [table],
  );
  return Number(r.n) > 0;
}

export async function preflight(q: Q): Promise<Finding[]> {
  const out: Finding[] = [];
  const ok = (check: string, detail: string) => out.push({ level: "info", check, detail });
  const err = (check: string, detail: string) => out.push({ level: "error", check, detail });
  /** Run a query that lists offenders; none means the check holds. */
  const offenders = async (check: string, sqlText: string, holds: string, describe: (r: Record<string, unknown>) => string) => {
    const rows = await q(sqlText);
    if (!rows.length) ok(check, holds);
    else err(check, `${rows.length} offender(s): ${rows.slice(0, SAMPLE).map(describe).join("; ")}${rows.length > SAMPLE ? "; …" : ""}`);
  };

  if (await present(q, "teams", "workspace_id"))
    await offenders(
      "teams: one key per workspace, any case",
      `select workspace_id, lower(key) as k, count(*)::int as n from teams group by 1, 2 having count(*) > 1`,
      "no two teams of a workspace share a key",
      (r) => `workspace ${r.workspace_id} has ${r.n} teams keyed ${r.k}`,
    );
  else err("teams: one key per workspace, any case", "skipped: teams.workspace_id is missing (bring the copy to migration 0020 first)");

  await offenders(
    "users: one email, any case",
    `select lower(email) as e, count(*)::int as n from users group by 1 having count(*) > 1`,
    "no two users share an email",
    (r) => `${r.e} is used by ${r.n} users`,
  );

  await offenders(
    "columns: one column per role per team",
    `select team_id, role, count(*)::int as n from columns where role is not null group by 1, 2 having count(*) > 1`,
    "no team has two columns with the same role",
    (r) => `team ${r.team_id} has ${r.n} columns with role ${r.role}`,
  );

  for (const t of ["nodes", "docs"]) {
    await offenders(
      `${t}: a parent is a ${t.slice(0, -1)} of the same team`,
      `select c.id, c.parent_id, (select count(*) from ${t} p where p.id = c.parent_id)::int as found from ${t} c where c.parent_id is not null and not exists (select 1 from ${t} p where p.id = c.parent_id and p.team_id = c.team_id)`,
      `every ${t}.parent_id names a row of the same team`,
      (r) => `${t} ${r.id} names parent ${r.parent_id} (${Number(r.found) ? "another team's" : "missing"})`,
    );
  }

  // 0022: the arrays that become rows. Anything that points at nothing would stop that migration; it is listed here instead.
  const UUID = "'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'";
  if (await present(q, "decisions", "node_ids"))
    await offenders(
      "decisions.node_ids: every id is a node of the decision's team",
      `select d.number, d.team_id, (e #>> '{}') as v from decisions d, jsonb_array_elements(d.node_ids) e
       where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~* ${UUID} or not exists (select 1 from nodes n where n.id::text = lower(e #>> '{}') and n.team_id = d.team_id)`,
      "every decision names only nodes of its own team",
      (r) => `ADR-${r.number} of team ${r.team_id} names ${JSON.stringify(r.v)}`,
    );
  if (await present(q, "invites", "teams"))
    await offenders(
      "invites.teams: every entry is a team of the invite's workspace, with a team role",
      `select i.id, g::text as v from invites i, jsonb_array_elements(i.teams) g
       where i.workspace_id is null or jsonb_typeof(g->'teamId') <> 'string' or (g->>'teamId') !~* ${UUID} or (g->>'role') not in ('admin', 'editor', 'viewer')
          or not exists (select 1 from teams t where t.id::text = lower(g->>'teamId') and t.workspace_id = i.workspace_id)`,
      "every invite grants only teams of its own workspace",
      (r) => `invite ${r.id} grants ${r.v}`,
    );
  if (await present(q, "tickets", "labels"))
    await offenders(
      "tickets.labels: every entry is text",
      `select t.id, e::text as v from tickets t, jsonb_array_elements(t.labels) e where jsonb_typeof(e) <> 'string'`,
      "every label is a string",
      (r) => `ticket ${r.id} has the label ${r.v}`,
    );

  let checked = 0;
  for (const { table, column, values } of enumColumns()) {
    if (!(await present(q, table, column))) {
      ok(`${table}.${column}: allowed values`, "not in this database yet (a later migration adds it)");
      continue;
    }
    checked++;
    await offenders(
      `${table}.${column}: allowed values`,
      `select ${qi(column)} as v, count(*)::int as n from ${qi(table)} where ${qi(column)} is not null and ${qi(column)} not in (${values.map(lit).join(", ")}) group by 1`,
      `every value is one of ${values.join(", ")}`,
      (r) => `${r.n} row(s) hold ${JSON.stringify(r.v)}`,
    );
  }
  ok("enum columns", `${checked} checked against the TypeScript enums`);
  return out;
}

/**
 * Remove the entries `preflight` lists for migration 0022 (a decision naming a node that is not of its team, an invite granting
 * a team that is not of its workspace): only those entries, from their arrays, and nothing else. It says what it removed. This is
 * the deliberate way to resolve them, never something a migration does on its own; run it on the database you mean to migrate.
 */
export async function resolveDangling(q: Q): Promise<string[]> {
  const UUID = "'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'";
  const said: string[] = [];
  if (await present(q, "decisions", "node_ids")) {
    const rows = await q(
      `select d.id, d.number, d.team_id, (e #>> '{}') as v from decisions d, jsonb_array_elements(d.node_ids) e
       where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~* ${UUID} or not exists (select 1 from nodes n where n.id::text = lower(e #>> '{}') and n.team_id = d.team_id)`,
    );
    for (const r of rows) {
      await q(
        `update decisions set node_ids = (select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements(node_ids) e where e <> to_jsonb($2::text)) where id = $1`,
        [r.id, r.v],
      );
      said.push(`ADR-${r.number} of team ${r.team_id}: removed the node ${JSON.stringify(r.v)}, which is not a node of that team`);
    }
  }
  if (await present(q, "invites", "teams")) {
    const rows = await q(
      `select i.id, g as grant_json from invites i, jsonb_array_elements(i.teams) g
       where i.workspace_id is null or jsonb_typeof(g->'teamId') <> 'string' or (g->>'teamId') !~* ${UUID} or (g->>'role') not in ('admin', 'editor', 'viewer')
          or not exists (select 1 from teams t where t.id::text = lower(g->>'teamId') and t.workspace_id = i.workspace_id)`,
    );
    for (const r of rows) {
      await q(`update invites set teams = (select coalesce(jsonb_agg(g), '[]'::jsonb) from jsonb_array_elements(teams) g where g <> $2::jsonb) where id = $1`, [r.id, JSON.stringify(r.grant_json)]);
      said.push(`invite ${r.id}: removed the grant ${JSON.stringify(r.grant_json)}, which is not a team of the invite's workspace`);
    }
  }
  return said;
}
