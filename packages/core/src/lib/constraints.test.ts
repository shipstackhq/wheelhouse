/**
 * The constraints of WH-114 against a real database: unique keys, same-team parents, and a CHECK for every enum column.
 * Runs on an in-memory PGlite (`pnpm test`), or a real Postgres with TEST_DATABASE_URL.
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  process.env.PGLITE_DIR = "memory://";
  delete process.env.DATABASE_URL;
}

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { getTableConfig, type PgColumn } from "drizzle-orm/pg-core";
import { getDb, schema } from "../db";
import type { Actor } from "./access";
import * as svc from "./service";

const RUN = Math.random().toString(16).slice(2, 8);
const L = RUN.replace(/[0-9]/g, (c) => "ghijklmnop"[Number(c)]).slice(0, 2).toUpperCase();

/** Postgres says which kind of refusal in `cause.code`: 23505 unique, 23503 foreign key, 23514 check. */
const refusedWith = (code: string) => (e: unknown) => (e as { cause?: { code?: string } }).cause?.code === code;
const unique = refusedWith("23505");
const foreign = refusedWith("23503");
const checked = refusedWith("23514");

let db: Awaited<ReturnType<typeof getDb>>;
let ada: Actor;
let a1: { id: string; workspaceId: string; key: string };
let a2: { id: string; workspaceId: string; key: string };
let wsA: string;
let wsB: string;

before(async () => {
  db = await getDb();
  const [a] = await db.insert(schema.workspaces).values({ name: `cons A ${RUN}` }).returning();
  const [b] = await db.insert(schema.workspaces).values({ name: `cons B ${RUN}` }).returning();
  wsA = a.id;
  wsB = b.id;
  const mk = async (workspaceId: string, name: string): Promise<Actor> => {
    const [u] = await db.insert(schema.users).values({ email: `${name}-${RUN}@example.com`, name, passwordHash: "x" }).returning();
    await db.insert(schema.memberships).values({ userId: u.id, workspaceId, role: "owner" });
    return { kind: "human", id: u.id, name, workspaceId };
  };
  ada = await mk(wsA, "ada");
  await mk(wsB, "bea");
  a1 = await svc.createTeam(ada, { name: "One", key: `${L}A` });
  a2 = await svc.createTeam(ada, { name: "Two", key: `${L}C` });
});

describe("unique keys", () => {
  test("a team key is unique within a workspace whatever its case, and free in another workspace", async () => {
    await assert.rejects(db.insert(schema.teams).values({ workspaceId: wsA, key: a1.key.toLowerCase(), name: "dup" }), unique);
    const other = await db.insert(schema.teams).values({ workspaceId: wsB, key: a1.key, name: "same key, other workspace" }).returning();
    assert.equal(other.length, 1);
  });

  test("an email is unique whatever its case", async () => {
    await assert.rejects(db.insert(schema.users).values({ email: `ADA-${RUN}@EXAMPLE.COM`, name: "dup", passwordHash: "x" }), unique);
  });

  test("a column role is held by one column per team; custom columns are not limited", async () => {
    const roleRows = await db.select().from(schema.columns).where(eq(schema.columns.teamId, a1.id));
    const withRole = roleRows.find((c) => c.role === "review")!;
    assert.ok(withRole);
    await assert.rejects(db.insert(schema.columns).values({ teamId: a1.id, workspaceId: wsA, name: "Second review", position: 50, role: "review" }), unique);
    await db.insert(schema.columns).values([
      { teamId: a1.id, workspaceId: wsA, name: "Custom one", position: 51, role: null },
      { teamId: a1.id, workspaceId: wsA, name: "Custom two", position: 52, role: null },
    ]);
    // the same role in another team is fine
    assert.ok((await db.select().from(schema.columns).where(eq(schema.columns.teamId, a2.id))).some((c) => c.role === "review"));
  });
});

describe("a parent is in the same team", () => {
  const node = (team: { id: string; workspaceId: string }, name: string, parentId: string | null = null) =>
    db.insert(schema.nodes).values({ teamId: team.id, workspaceId: team.workspaceId, layer: "system", kind: "service", name, parentId }).returning();

  test("a node's parent must be a node of its own team: another team's and a made-up id are refused", async () => {
    const [p1] = await node(a1, "parent in one");
    const [p2] = await node(a2, "parent in two");
    await assert.rejects(node(a1, "child of the other team's node", p2.id), foreign);
    await assert.rejects(node(a1, "child of nothing", crypto.randomUUID()), foreign);
    const [child] = await node(a1, "good child", p1.id);
    assert.equal(child.parentId, p1.id);
    await assert.rejects(db.update(schema.nodes).set({ parentId: p2.id }).where(eq(schema.nodes.id, child.id)), foreign);
  });

  test("deleting a node deletes the ones nested in it", async () => {
    const [p] = await node(a1, "doomed parent");
    const [c] = await node(a1, "doomed child", p.id);
    const [g] = await node(a1, "doomed grandchild", c.id);
    await db.delete(schema.nodes).where(eq(schema.nodes.id, p.id));
    assert.equal((await db.select().from(schema.nodes).where(eq(schema.nodes.id, g.id))).length, 0);
  });

  test("a doc's parent must be a doc of its own team", async () => {
    const doc = (team: { id: string; workspaceId: string }, slug: string, parentId: string | null = null) =>
      db.insert(schema.docs).values({ teamId: team.id, workspaceId: team.workspaceId, slug, title: slug, createdByKind: "human", updatedByKind: "human", position: 0, parentId }).returning();
    const [d1] = await doc(a1, `d1-${RUN}`);
    const [d2] = await doc(a2, `d2-${RUN}`);
    await assert.rejects(doc(a1, `x-${RUN}`, d2.id), foreign);
    await assert.rejects(doc(a1, `y-${RUN}`, crypto.randomUUID()), foreign);
    assert.equal((await doc(a1, `z-${RUN}`, d1.id)).length, 1);
  });
});

describe("a value outside its enum is refused", () => {
  // Each statement is raw SQL: TypeScript would not let the bad value through.
  const bad: [string, () => Promise<unknown>][] = [
    ["memberships.role", () => db.execute(sql`update memberships set role = 'boss' where user_id = ${ada.id}`)],
    ["team_members.role", () => db.execute(sql`insert into team_members (team_id, workspace_id, user_id, role) values (${a1.id}, ${wsA}, ${ada.id}, 'god')`)],
    ["tickets.priority", () => db.execute(sql`update tickets set priority = 'asap'`)],
    ["columns.role", () => db.execute(sql`update columns set role = 'qa' where team_id = ${a2.id} and role = 'todo'`)],
    ["nodes.layer", () => db.execute(sql`insert into nodes (team_id, workspace_id, layer, kind, name) values (${a1.id}, ${wsA}, 'cloud', 'service', 'x')`)],
    ["nodes.kind", () => db.execute(sql`insert into nodes (team_id, workspace_id, layer, kind, name) values (${a1.id}, ${wsA}, 'system', 'lambda', 'x')`)],
    ["nodes.status", () => db.execute(sql`insert into nodes (team_id, workspace_id, layer, kind, name, status) values (${a1.id}, ${wsA}, 'system', 'service', 'x', 'dead')`)],
    ["edges.kind", () => db.execute(sql`update edges set kind = 'likes'`)],
    ["decisions.status", () => db.execute(sql`insert into decisions (team_id, workspace_id, number, title, status, author_kind, author_name) values (${a1.id}, ${wsA}, 9999, 't', 'maybe', 'human', 'x')`)],
    ["events.actor_kind", () => db.execute(sql`update events set actor_kind = 'robot'`)],
    ["events.entity", () => db.execute(sql`update events set entity = 'project'`)],
    ["repositories.provider", () => db.execute(sql`insert into repositories (team_id, workspace_id, display_name, role, slug, provider) values (${a1.id}, ${wsA}, 'r', 'x', 'bad-provider', 'gitlab')`)],
    ["repositories.lifecycle", () => db.execute(sql`insert into repositories (team_id, workspace_id, display_name, role, slug, lifecycle) values (${a1.id}, ${wsA}, 'r', 'x', 'bad-life', 'zombie')`)],
    ["invites.kind", () => db.execute(sql`insert into invites (kind, email, token_hash, expires_at) values ('join_team', 'x@example.com', ${`t-${RUN}`}, now())`)],
    ["audit_events.target_type", () => db.execute(sql`insert into audit_events (workspace_id, actor_kind, actor_name, action, target_type) values (${wsA}, 'human', 'x', 'a', 'project')`)],
    ["docs.stale_source", () => db.execute(sql`insert into docs (team_id, workspace_id, slug, title, created_by_kind, updated_by_kind, stale_source) values (${a1.id}, ${wsA}, 'ss', 't', 'human', 'human', 'magic')`)],
  ];
  before(async () => {
    // rows for the update-style cases to act on
    await svc.createTicket(ada, a2.key, { title: "for the priority check" });
    const [x] = await db.insert(schema.nodes).values({ teamId: a2.id, workspaceId: wsA, layer: "system", kind: "service", name: "e1" }).returning();
    const [y] = await db.insert(schema.nodes).values({ teamId: a2.id, workspaceId: wsA, layer: "system", kind: "service", name: "e2" }).returning();
    await db.insert(schema.edges).values({ teamId: a2.id, workspaceId: wsA, fromNodeId: x.id, toNodeId: y.id });
  });
  for (const [what, attempt] of bad) test(what, async () => assert.rejects(attempt(), checked));

  test("a null is still allowed where the column allows it (a custom column has no role)", async () => {
    await db.insert(schema.columns).values({ teamId: a2.id, workspaceId: wsA, name: "No role", position: 70, role: null });
  });
});

describe("the TypeScript enums and the CHECK constraints agree", () => {
  const enumColumns = () => {
    const out: { table: string; column: string; values: string[] }[] = [];
    for (const t of Object.values(schema)) {
      let cfg;
      try {
        cfg = getTableConfig(t as never);
      } catch {
        continue;
      }
      if (!cfg?.name) continue;
      for (const c of cfg.columns as PgColumn[]) if (Array.isArray(c.enumValues) && c.enumValues.length) out.push({ table: cfg.name, column: c.name, values: [...c.enumValues] });
    }
    return out;
  };
  const valuesIn = (def: string) => [...def.matchAll(/'((?:[^']|'')*)'::text/g)].map((m) => m[1].replaceAll("''", "'")).sort();

  test("every enum column has a CHECK with exactly its values, and every enum CHECK belongs to an enum column", async () => {
    const res = await db.execute(sql`
      select c.conname, pg_get_constraintdef(c.oid) as def
      from pg_constraint c where c.contype = 'c' and c.connamespace = 'public'::regnamespace and c.conname like '%\\_check'`);
    const list = (Array.isArray(res) ? res : (res as unknown as { rows: unknown[] }).rows) as { conname: string; def: string }[];
    // CHECKs that are about a rule, not about an enum, are named here.
    const notEnums = new Set(["cycles_window_check"]);
    const inDb = new Map(list.filter((r) => !notEnums.has(r.conname)).map((r) => [r.conname, valuesIn(r.def)]));
    const expected = enumColumns();
    assert.ok(expected.length >= 30, `found only ${expected.length} enum columns`);
    for (const e of expected) {
      const name = `${e.table}_${e.column}_check`;
      assert.ok(inDb.has(name), `${name} is missing from the database`);
      assert.deepEqual(inDb.get(name), [...e.values].sort(), `${name} disagrees with its TypeScript enum`);
    }
    const names = new Set(expected.map((e) => `${e.table}_${e.column}_check`));
    for (const n of inDb.keys()) assert.ok(names.has(n), `${n} is in the database but no enum column in schema.ts has it`);
  });
});
