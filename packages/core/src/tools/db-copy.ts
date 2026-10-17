import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { migrationsFolder } from "../db";
import * as schema from "../db/schema";

/**
 * Moving Wheelhouse's data from one database to another (WH-100): PGlite directory or Postgres, either way round, as a
 * logical copy. The schema is frozen, so this is an export and an import, not a transform:
 *
 *   export  every table, in dependency order, as one JSON line per row (`to_jsonb(row)`, never parsed in JavaScript, so
 *           nothing is rounded or reformatted), plus a manifest: rows and a content checksum per table, the sequences, the migrations
 *   import  into a database that has just been migrated and is EMPTY, in one transaction (a failure leaves the target empty, so
 *           it is safe to run again), then the sequences are set where the source had them
 *   verify  the same checksums computed on the target and compared with the manifest, plus integrity checks on the target alone
 *
 * It never writes to the source. A PGlite directory belongs to one process at a time, so the source is copied first (unless
 * told not to) and the copy is opened. Stop the app that owns a live directory (SIGTERM, so it flushes) before exporting it.
 */

export type Row = Record<string, unknown>;
export type Q = (sql: string, params?: unknown[]) => Promise<Row[]>;
export type Conn = { label: string; kind: "pglite" | "postgres"; query: Q; tx<T>(fn: (q: Q) => Promise<T>): Promise<T>; close(): Promise<void> };

const require = createRequire(import.meta.url);
const isUrl = (s: string) => /^postgres(ql)?:\/\//i.test(s);
const qi = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Open a database: `postgres://…` or the path of a PGlite directory (or `memory://`). With `migrate`, bring it to the current schema first. */
export async function openConn(target: string, o: { migrate?: boolean; create?: boolean } = {}): Promise<Conn> {
  let conn: Conn;
  if (isUrl(target)) {
    const postgres = require("postgres") as typeof import("postgres");
    // One connection, so the session settings below apply to everything. UTC makes timestamps print the same on both sides.
    const sql = postgres(target, { max: 1, prepare: false, onnotice: () => {}, connection: { TimeZone: "UTC" } });
    conn = {
      label: target.replace(/:\/\/([^:@/]+):[^@]*@/, "://$1:***@"),
      kind: "postgres",
      query: async (text, params) => (await sql.unsafe(text, params as never[] ?? [])) as unknown as Row[],
      tx: (fn) => sql.begin(async (t) => fn(async (text, params) => (await t.unsafe(text, params as never[] ?? [])) as unknown as Row[])) as Promise<never>,
      close: () => sql.end(),
    };
    if (o.migrate) {
      const { drizzle } = require("drizzle-orm/postgres-js") as typeof import("drizzle-orm/postgres-js");
      const { migrate } = await import("drizzle-orm/postgres-js/migrator");
      await migrate(drizzle(sql, { schema }), { migrationsFolder: migrationsFolder() });
    }
  } else {
    const memory = target.startsWith("memory://");
    if (!memory && !o.create && !fs.existsSync(path.join(target, "PG_VERSION"))) throw new Error(`${target} is not a PGlite data directory (no PG_VERSION)`);
    if (!memory) fs.mkdirSync(target, { recursive: true });
    const { PGlite } = require("@electric-sql/pglite") as typeof import("@electric-sql/pglite");
    const client = new PGlite(target);
    await client.waitReady;
    await client.query("set time zone 'UTC'");
    conn = {
      label: target,
      kind: "pglite",
      query: async (text, params) => (await client.query(text, params as never[])).rows as Row[],
      tx: (fn) => client.transaction((t) => fn(async (text, params) => (await t.query(text, params as never[])).rows as Row[])),
      close: () => client.close(),
    };
    if (o.migrate) {
      const { drizzle } = require("drizzle-orm/pglite") as typeof import("drizzle-orm/pglite");
      const { migrate } = await import("drizzle-orm/pglite/migrator");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await migrate(drizzle(client, { schema }) as any, { migrationsFolder: migrationsFolder() });
    }
  }
  return conn;
}

// ───────── what is in a database ─────────

export type TableInfo = { name: string; parents: string[] };

/** The application's tables (every table of the public schema) with the tables each one points at, parents before children. */
export async function tablesInOrder(q: Q): Promise<TableInfo[]> {
  const names = (await q(`select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by c.relname`)).map((r) => String(r.name));
  const fks = await q(`select conrelid::regclass::text as child, confrelid::regclass::text as parent from pg_constraint where contype = 'f' and connamespace = 'public'::regnamespace`);
  const parents = new Map<string, Set<string>>(names.map((n) => [n, new Set()]));
  for (const f of fks) {
    const child = String(f.child).replaceAll('"', "");
    const parent = String(f.parent).replaceAll('"', "");
    if (child !== parent && parents.has(child)) parents.get(child)!.add(parent);
  }
  const ordered: TableInfo[] = [];
  const done = new Set<string>();
  while (ordered.length < names.length) {
    const next = names.filter((n) => !done.has(n) && [...parents.get(n)!].every((p) => done.has(p)));
    if (!next.length) throw new Error(`tables point at each other in a cycle: ${names.filter((n) => !done.has(n)).join(", ")}`);
    for (const n of next) {
      done.add(n);
      ordered.push({ name: n, parents: [...parents.get(n)!].sort() });
    }
  }
  return ordered;
}

export type TableSummary = { name: string; rows: number; md5: string };
export type SequenceState = { name: string; lastValue: string; isCalled: boolean };
export type Snapshot = { tables: TableSummary[]; sequences: SequenceState[]; migrations: string[] };

/**
 * What a database holds, reduced to comparable facts. The checksum of a table is the md5 of its rows as JSON, one per line, in
 * byte order of that text, so it does not depend on the database's collation or on how rows happen to be stored.
 */
export async function snapshot(q: Q): Promise<Snapshot> {
  const tables: TableSummary[] = [];
  for (const t of await tablesInOrder(q)) {
    const [r] = await q(`select count(*)::int as n, md5(coalesce(string_agg(to_jsonb(t)::text, E'\\n' order by convert_to(to_jsonb(t)::text, 'UTF8')), '')) as h from ${qi(t.name)} t`);
    tables.push({ name: t.name, rows: Number(r.n), md5: String(r.h) });
  }
  const seqs = await q(`select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'S' order by 1`);
  const sequences: SequenceState[] = [];
  for (const s of seqs) {
    const [v] = await q(`select last_value::text as v, is_called as c from ${qi(String(s.name))}`);
    sequences.push({ name: String(s.name), lastValue: String(v.v), isCalled: Boolean(v.c) });
  }
  const migrations = (await q(`select hash from drizzle.__drizzle_migrations order by id`)).map((r) => String(r.hash));
  return { tables, sequences, migrations };
}

// ───────── export ─────────

export type Manifest = { format: 1; createdAt: string; source: string; snapshot: Snapshot };

export type ExportResult = { manifest: Manifest; dir: string; seconds: number };

/** Write every table to `<out>/<table>.ndjson` and the manifest to `<out>/manifest.json`. `out` must not already hold an export. */
export async function exportData(q: Q, out: string, source: string): Promise<ExportResult> {
  const started = Date.now();
  if (fs.existsSync(path.join(out, "manifest.json"))) throw new Error(`${out} already holds an export; choose an empty folder`);
  fs.mkdirSync(out, { recursive: true });
  // One transaction, so every table is read as of the same moment.
  const manifest = await (async () => {
    await q("begin isolation level repeatable read read only");
    try {
      const snap = await snapshot(q);
      for (const t of snap.tables) {
        const lines = (await q(`select to_jsonb(t)::text as j from ${qi(t.name)} t order by convert_to(to_jsonb(t)::text, 'UTF8')`)).map((r) => String(r.j));
        fs.writeFileSync(path.join(out, `${t.name}.ndjson`), lines.length ? lines.join("\n") + "\n" : "");
        if (lines.length !== t.rows) throw new Error(`${t.name}: read ${lines.length} rows but counted ${t.rows}`);
      }
      return { format: 1 as const, createdAt: new Date().toISOString(), source, snapshot: snap };
    } finally {
      await q("rollback");
    }
  })();
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { manifest, dir: out, seconds: (Date.now() - started) / 1000 };
}

// ───────── import ─────────

const BATCH = 200;

export type ImportResult = { tables: { name: string; rows: number }[]; seconds: number };

/**
 * Load an export into a database that has been migrated and is empty. All or nothing. The target's migrations must be the very
 * ones the export came from, so the tables mean the same thing on both sides.
 */
export async function importData(conn: Conn, dir: string): Promise<ImportResult> {
  const started = Date.now();
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as Manifest;
  if (manifest.format !== 1) throw new Error(`unknown export format ${manifest.format}`);
  const target = await snapshot(conn.query);
  if (JSON.stringify(target.migrations) !== JSON.stringify(manifest.snapshot.migrations)) {
    throw new Error(`the target's migrations (${target.migrations.length}) are not the export's (${manifest.snapshot.migrations.length}); migrate it with the same code first`);
  }
  const notEmpty = target.tables.filter((t) => t.rows > 0).map((t) => `${t.name} (${t.rows})`);
  if (notEmpty.length) throw new Error(`the target is not empty: ${notEmpty.join(", ")}. Import into a fresh database.`);
  const order = await tablesInOrder(conn.query);
  const wanted = new Set(manifest.snapshot.tables.map((t) => t.name));
  const unknown = [...wanted].filter((n) => !order.some((t) => t.name === n));
  if (unknown.length) throw new Error(`the export has tables the target does not: ${unknown.join(", ")}`);

  const loaded: { name: string; rows: number }[] = [];
  await conn.tx(async (q) => {
    for (const t of order) {
      const file = path.join(dir, `${t.name}.ndjson`);
      const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
      for (let i = 0; i < lines.length; i += BATCH) {
        // The rows go in as JSON text and the database does the typing (uuid, timestamptz, jsonb, bigint, arrays, doubles).
        await q(`insert into ${qi(t.name)} select * from jsonb_populate_recordset(null::${qi(t.name)}, $1::jsonb)`, [`[${lines.slice(i, i + BATCH).join(",")}]`]);
      }
      loaded.push({ name: t.name, rows: lines.length });
    }
    for (const s of manifest.snapshot.sequences) await q(`select setval($1::regclass, $2::bigint, $3::boolean)`, [qi(s.name), s.lastValue, s.isCalled]);
  });
  return { tables: loaded, seconds: (Date.now() - started) / 1000 };
}

// ───────── verify ─────────

export type Finding = { level: "error" | "info"; check: string; detail: string };

/** The target as it is now against what the export said the source held. Every difference is a finding; none is an error only if all agree. */
export function compare(expected: Snapshot, actual: Snapshot): Finding[] {
  const out: Finding[] = [];
  const err = (check: string, detail: string) => out.push({ level: "error", check, detail });
  if (JSON.stringify(expected.migrations) !== JSON.stringify(actual.migrations)) err("migrations", `expected ${expected.migrations.length}, found ${actual.migrations.length}, or different ones`);
  const have = new Map(actual.tables.map((t) => [t.name, t]));
  for (const t of expected.tables) {
    const a = have.get(t.name);
    if (!a) err(`table ${t.name}`, "missing in the target");
    else if (a.rows !== t.rows) err(`table ${t.name}`, `${t.rows} rows expected, ${a.rows} found`);
    else if (a.md5 !== t.md5) err(`table ${t.name}`, `same row count (${t.rows}) but the content differs (checksum ${t.md5.slice(0, 8)} vs ${a.md5.slice(0, 8)})`);
  }
  for (const t of actual.tables) if (!expected.tables.some((e) => e.name === t.name)) err(`table ${t.name}`, "is in the target but not in the source");
  const seqs = new Map(actual.sequences.map((s) => [s.name, s]));
  for (const s of expected.sequences) {
    const a = seqs.get(s.name);
    if (!a) err(`sequence ${s.name}`, "missing in the target");
    else if (a.lastValue !== s.lastValue || a.isCalled !== s.isCalled) err(`sequence ${s.name}`, `expected ${s.lastValue} (called: ${s.isCalled}), found ${a.lastValue} (called: ${a.isCalled})`);
  }
  if (!out.length) out.push({ level: "info", check: "content", detail: `${expected.tables.length} tables, ${expected.tables.reduce((n, t) => n + t.rows, 0)} rows, ${expected.sequences.length} sequence(s) and ${expected.migrations.length} migrations are identical` });
  return out;
}

/**
 * Things that must be true of any database holding Wheelhouse's data, whatever it was copied from: every foreign key resolves, every
 * cursor points at an event that exists, credentials look like what the app stores. Reads only.
 */
export async function integrity(q: Q): Promise<Finding[]> {
  const out: Finding[] = [];
  const err = (check: string, detail: string) => out.push({ level: "error", check, detail });
  const ok = (check: string, detail: string) => out.push({ level: "info", check, detail });

  const fks = await q(`
    select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent, c.conname as name,
      (select array_agg(a.attname::text order by k.i) from unnest(c.conkey) with ordinality as k(attnum, i) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as child_cols,
      (select array_agg(a.attname::text order by k.i) from unnest(c.confkey) with ordinality as k(attnum, i) join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum) as parent_cols
    from pg_constraint c where c.contype = 'f' and c.connamespace = 'public'::regnamespace order by 1, 3`);
  let orphans = 0;
  for (const f of fks) {
    const cc = f.child_cols as string[];
    const pc = f.parent_cols as string[];
    const [r] = await q(
      `select count(*)::int as n from ${f.child} c where ${cc.map((c) => `c.${qi(c)} is not null`).join(" and ")} and not exists (select 1 from ${f.parent} p where ${pc.map((p, i) => `p.${qi(p)} = c.${qi(cc[i])}`).join(" and ")})`,
    );
    if (Number(r.n) > 0) {
      orphans += Number(r.n);
      err(`foreign key ${f.name}`, `${r.n} row(s) of ${f.child} point at a ${f.parent} that is not there`);
    }
  }
  if (!orphans) ok("foreign keys", `all ${fks.length} resolve`);

  const [maxSeq] = await q(`select coalesce(max(seq), 0)::text as m from events`);
  const [seqState] = await q(`select last_value::text as v from events_seq_seq`);
  if (BigInt(String(seqState.v)) < BigInt(String(maxSeq.m))) err("events.seq", `the sequence (${seqState.v}) is behind the newest event (${maxSeq.m}): the next event would reuse a number`);
  else ok("events.seq", `newest event ${maxSeq.m}, sequence at ${seqState.v}`);

  for (const [table, col] of [["agent_cursors", "last_seq"], ["work_sessions", "last_seq"], ["work_sessions", "resume_from_seq"]] as const) {
    const [r] = await q(`select count(*)::int as n from ${table} where ${col} is not null and ${col} > (select coalesce(max(seq), 0) from events)`);
    if (Number(r.n) > 0) err(`${table}.${col}`, `${r.n} cursor(s) are ahead of the newest event`);
  }
  const [cursors] = await q(`select (select count(*) from agent_cursors)::int as a, (select count(*) from work_sessions)::int as s`);
  ok("cursors", `${cursors.a} agent cursor(s) and ${cursors.s} session(s), none ahead of the newest event`);

  const [keys] = await q(`select count(*)::int as n, count(*) filter (where key_hash !~ '^[0-9a-f]{64}$')::int as bad, count(*) filter (where revoked_at is null)::int as live from api_keys`);
  if (Number(keys.bad) > 0) err("api_keys", `${keys.bad} key hash(es) are not a sha256 hex string`);
  else ok("api_keys", `${keys.n} key(s), ${keys.live} not revoked, every hash a sha256`);
  const [sess] = await q(`select count(*)::int as n, count(*) filter (where id !~ '^[0-9a-f]{64}$')::int as bad from sessions`);
  if (Number(sess.bad) > 0) err("sessions", `${sess.bad} session id(s) are not a sha256 hex string`);
  else ok("sessions", `${sess.n} session(s), every id a sha256`);
  const [people] = await q(`select (select count(*) from users)::int as u, (select count(*) from teams)::int as t, (select count(*) from memberships)::int as m`);
  ok("people", `${people.u} user(s), ${people.t} team(s), ${people.m} membership(s)`);
  return out;
}

/** Copy a PGlite directory somewhere private so opening it cannot touch the original. */
export function copyDirToTemp(dir: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wh-export-"));
  const to = path.join(tmp, "pglite");
  fs.cpSync(dir, to, { recursive: true });
  return to;
}
