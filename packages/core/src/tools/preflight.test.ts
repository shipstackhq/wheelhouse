import { test } from "node:test";
import assert from "node:assert/strict";
import { openConn } from "./db-copy";
import { preflight } from "./preflight";

// The state migration 0021 starts from: everything up to 0020, none of the new constraints.
const open = () => openConn("memory://", { migrate: true, create: true, through: "0020" });

test("an empty database at 0020 passes", async () => {
  const conn = await open();
  try {
    const findings = await preflight(conn.query);
    assert.deepEqual(findings.filter((f) => f.level === "error"), []);
    assert.ok(findings.some((f) => f.check === "enum columns" && /\d+ checked/.test(f.detail)));
  } finally {
    await conn.close();
  }
});

test("every kind of offender is found and named, and nothing is changed", async () => {
  const conn = await open();
  try {
    const q = conn.query;
    await q(`insert into workspaces (name) values ('W')`);
    await q(`insert into users (email, name, password_hash) values ('Dup@x.io', 'a', 'h'), ('dup@x.io', 'b', 'h')`);
    await q(`insert into teams (workspace_id, key, name) select id, k, 'T' from workspaces, (values ('AB'), ('ab'), ('CD'), ('EF')) as v(k)`);
    await q(`insert into columns (team_id, workspace_id, name, position, role) select t.id, t.workspace_id, n, p, 'review' from teams t, (values ('R1', 1), ('R2', 2)) as v(n, p) where t.key = 'CD'`);
    await q(`insert into nodes (team_id, workspace_id, layer, kind, name) select id, workspace_id, 'system', 'service', 'in CD' from teams where key = 'CD'`);
    await q(`insert into nodes (team_id, workspace_id, layer, kind, name, parent_id) select e.id, e.workspace_id, 'system', 'service', 'child in EF', (select n.id from nodes n limit 1) from teams e where e.key = 'EF'`);
    await q(`insert into docs (team_id, workspace_id, slug, title, created_by_kind, updated_by_kind, parent_id) select id, workspace_id, 'orphan', 'o', 'human', 'human', gen_random_uuid() from teams where key = 'CD'`);
    await q(`insert into nodes (team_id, workspace_id, layer, kind, name) select id, workspace_id, 'cloud', 'lambda', 'bad enum' from teams where key = 'EF'`);
    const before = await q(`select (select count(*) from teams)::int as t, (select count(*) from nodes)::int as n`);

    const findings = await preflight(conn.query);
    const errors = new Map(findings.filter((f) => f.level === "error").map((f) => [f.check, f.detail]));
    assert.match(errors.get("teams: one key per workspace, any case")!, /2 teams keyed ab/);
    assert.match(errors.get("users: one email, any case")!, /dup@x\.io is used by 2 users/);
    assert.match(errors.get("columns: one column per role per team")!, /2 columns with role review/);
    assert.match(errors.get("nodes: a parent is a node of the same team")!, /another team's/);
    assert.match(errors.get("docs: a parent is a doc of the same team")!, /missing/);
    assert.match(errors.get("nodes.layer: allowed values")!, /"cloud"/);
    assert.match(errors.get("nodes.kind: allowed values")!, /"lambda"/);
    assert.deepEqual(await q(`select (select count(*) from teams)::int as t, (select count(*) from nodes)::int as n`), before, "it only reads");
  } finally {
    await conn.close();
  }
});

test("--through stops at the migration it is given", async () => {
  const conn = await open();
  try {
    const [{ n }] = (await conn.query("select count(*)::int as n from drizzle.__drizzle_migrations")) as { n: number }[];
    assert.equal(n, 21, "0000 to 0020");
    const [{ c }] = (await conn.query(`select count(*)::int as c from pg_constraint where conname = 'nodes_parent_fk'`)) as { c: number }[];
    assert.equal(c, 0);
  } finally {
    await conn.close();
  }
});

test("references that point at nothing are listed before migration 0022 would stop on them", async () => {
  const conn = await open();
  try {
    const q = conn.query;
    await q(`insert into workspaces (name) values ('W1'), ('W2')`);
    await q(`insert into teams (workspace_id, key, name) select id, case name when 'W1' then 'AA' else 'BB' end, 'T' from workspaces`);
    await q(`insert into nodes (team_id, workspace_id, layer, kind, name) select id, workspace_id, 'system', 'service', 'n' from teams where key = 'AA'`);
    await q(
      `insert into decisions (team_id, workspace_id, number, title, author_kind, author_name, node_ids)
       select t.id, t.workspace_id, 1, 'dangling', 'human', 'x', jsonb_build_array((select id::text from nodes limit 1), gen_random_uuid()::text, 'not-a-uuid') from teams t where key = 'AA'`,
    );
    await q(
      `insert into invites (kind, email, workspace_id, token_hash, expires_at, teams)
       select 'join_workspace', 'a@x.io', w.id, 'tok', now(), jsonb_build_array(jsonb_build_object('teamId', (select id::text from teams where key = 'BB'), 'role', 'editor')) from workspaces w where w.name = 'W1'`,
    );
    await q(`update tickets set labels = labels`);
    const errors = new Map((await preflight(conn.query)).filter((f) => f.level === "error").map((f) => [f.check, f.detail]));
    assert.match(errors.get("decisions.node_ids: every id is a node of the decision's team")!, /2 offender/);
    assert.match(errors.get("invites.teams: every entry is a team of the invite's workspace, with a team role")!, /1 offender/);
  } finally {
    await conn.close();
  }
});
