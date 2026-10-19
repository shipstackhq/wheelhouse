/**
 * The data tools (WH-100). They move a database between PGlite and Postgres; a mistake here loses or corrupts what the workspace wrote, so the
 * tests are about exactness (nothing rounded, reformatted or reordered), about refusing to make a mess, and about noticing one when it is made.
 * The Postgres cases run when TEST_DATABASE_URL is set (a scratch database is created and dropped), as in CI.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { sql } from "drizzle-orm";
import { closeDb, getDb, schema } from "../db";
import type { Actor } from "../lib/access";
import * as svc from "../lib/service";
import { compare, copyDirToTemp, exportData, importData, integrity, openConn, snapshot, tablesInOrder, type Conn } from "./db-copy";

const require = createRequire(import.meta.url);
const work = fs.mkdtempSync(path.join(os.tmpdir(), "wh-dbcopy-"));
const BIG = "9007199254740993"; // 2^53 + 1: a JavaScript number cannot hold it, a bigint column can
const TRICKY = "emoji 🧭, quote \" backslash \\ newline\nand a tab\t, nul-free unicode ñ 漢字, <script>";
let source = ""; // the PGlite directory with the seeded data
let exportDir = "";
const open: Conn[] = [];
const track = async (c: Promise<Conn>) => {
  const conn = await c;
  open.push(conn);
  return conn;
};

before(async () => {
  source = path.join(work, "source");
  process.env.PGLITE_DIR = source;
  delete process.env.DATABASE_URL;
  const db = await getDb();
  const [workspace] = await db.insert(schema.workspaces).values({ name: "Move workspace" }).returning();
  const [user] = await db.insert(schema.users).values({ email: "move@example.test", name: "Mo", passwordHash: "x" }).returning();
  await db.insert(schema.memberships).values({ userId: user.id, workspaceId: workspace.id, role: "owner" });
  const actor: Actor = { kind: "human", id: user.id, name: user.name, workspaceId: workspace.id };
  await svc.createTeam(actor, { name: "Move", key: "MV", description: TRICKY });
  const t = await svc.createTicket(actor, "MV", { title: TRICKY, body: "body" });
  await svc.addComment(actor, t.id, "a comment");
  const a = await svc.upsertNode(actor, "MV", { name: "API", layer: "system", summary: TRICKY, anchors: ["src/a.ts"] });
  const b = await svc.upsertNode(actor, "MV", { name: "DB", layer: "data", summary: "s" });
  await svc.upsertEdge(actor, "MV", { from: a.id, to: b.id, label: "reads" });
  await svc.createDoc(actor, "MV", { title: "Doc", body: TRICKY, anchors: ["src/a.ts"] });
  await svc.upsertDecision(actor, "MV", { title: "Use it", context: TRICKY });
  await svc.upsertTerm(actor, "MV", { term: "Thing", definition: "a thing" });
  await svc.upsertFlow(actor, "MV", { name: "Go", steps: [{ node: a.id, title: "start" }] });
  const [key] = await db.insert(schema.apiKeys).values({ workspaceId: workspace.id, name: "k", prefix: "wh_abc", keyHash: "a".repeat(64), createdBy: user.id }).returning();
  const [team] = await db.select().from(schema.teams);
  await db.insert(schema.agentCursors).values({ apiKeyId: key.id, teamId: team.id, lastSeq: 3 });
  await db.insert(schema.sessions).values({ id: "b".repeat(64), userId: user.id, expiresAt: new Date(Date.now() + 864e5) });
  await db.insert(schema.githubInstallations).values({ installationId: "4242", workspaceId: workspace.id, accountLogin: "acme", accountType: "Organization", connectedBy: user.id });
  await db.insert(schema.repositories).values({ teamId: team.id, displayName: "repo", role: "app", provider: "github", slug: "acme/repo", githubRepoId: "99", githubInstallationId: "4242", githubFullName: "acme/repo", defaultBranch: "main" });
  await db.insert(schema.workSessions).values({ id: "sess-1", teamId: team.id, apiKeyId: key.id, actorName: "Claude", lastSeq: 2, files: { "a.ts": { hash: "h" } } as never });
  // Values that a careless copy gets wrong: the newest event's number past 2^53, a double that is not exact, a microsecond timestamp, an empty string beside a null.
  await db.execute(sql`update work_sessions set resume_from_seq = 2, resume_removed_at = '2026-10-17T12:34:56.789123+00:00' where id = 'sess-1'`);
  await db.execute(sql`update events set seq = ${BIG}::bigint where seq = (select max(seq) from events)`); // the newest event's number is past 2^53
  await db.execute(sql`update docs set position = 0.1 + 0.2`);
  await db.execute(sql`update tickets set body = ''`);
  await db.execute(sql`select setval('events_seq_seq', ${BIG}::bigint + 10, true)`); // a sequence ahead of the newest event, as after rolled-back inserts
  await closeDb();
  exportDir = path.join(work, "export");
  const src = await track(openConn(copyDirToTemp(source)));
  await exportData(src.query, exportDir, "test source");
});

after(async () => {
  for (const c of open) await c.close().catch(() => {});
  await closeDb();
  fs.rmSync(work, { recursive: true, force: true });
});

const fresh = async (name: string) => track(openConn(path.join(work, name), { migrate: true, create: true }));

describe("export and import between PGlite directories", () => {
  test("the target ends up identical: every table's rows and checksum, the sequence, the migrations", async () => {
    const dst = await fresh("dst-1");
    const r = await importData(dst, exportDir);
    assert.ok(r.tables.find((t) => t.name === "tickets")!.rows === 1);
    const manifest = JSON.parse(fs.readFileSync(path.join(exportDir, "manifest.json"), "utf8"));
    const findings = compare(manifest.snapshot, await snapshot(dst.query));
    assert.deepEqual(findings.filter((f) => f.level === "error"), []);
    assert.ok(manifest.snapshot.tables.reduce((n: number, t: { rows: number }) => n + t.rows, 0) > 20, "there was something to move");
  });

  test("nothing is rounded or reformatted: the newest event's number past 2^53, an inexact double, a microsecond timestamp, unicode, '' versus null", async () => {
    const dst = await fresh("dst-2");
    await importData(dst, exportDir);
    const [s] = await dst.query(`select (select max(seq)::text from events) as seq, resume_removed_at::text as at from work_sessions where id = 'sess-1'`);
    assert.equal(s.seq, BIG);
    assert.equal(s.at, "2026-10-17 12:34:56.789123+00");
    assert.equal((await dst.query(`select position = 0.1 + 0.2 as same from docs`))[0].same, true);
    assert.equal((await dst.query(`select title from tickets`))[0].title, TRICKY);
    assert.equal((await dst.query(`select body from tickets`))[0].body, "");
    assert.equal((await dst.query(`select count(*)::int as n from work_sessions where branch is null`))[0].n, 1);
    assert.deepEqual((await dst.query(`select files from work_sessions`))[0].files, { "a.ts": { hash: "h" } });
  });

  test("the events sequence is set where the source had it, so a new event cannot reuse a number", async () => {
    const dst = await fresh("dst-3");
    await importData(dst, exportDir);
    const [seq] = await dst.query(`select last_value::text as v, is_called as c from events_seq_seq`);
    assert.deepEqual([seq.v, seq.c], ["9007199254741003", true]);
    const [next] = await dst.query(`select nextval('events_seq_seq')::text as n`);
    assert.equal(next.n, "9007199254741004");
  });

  test("credentials survive as stored: key hashes, session ids, the installation and the repository", async () => {
    const dst = await fresh("dst-4");
    await importData(dst, exportDir);
    assert.equal((await dst.query(`select key_hash from api_keys`))[0].key_hash, "a".repeat(64));
    assert.equal((await dst.query(`select id from sessions`))[0].id, "b".repeat(64));
    assert.equal((await dst.query(`select account_login from github_installations`))[0].account_login, "acme");
    assert.equal((await dst.query(`select github_repo_id from repositories`))[0].github_repo_id, "99");
    assert.equal((await dst.query(`select last_seq::int as s from agent_cursors`))[0].s, 3);
  });

  test("the import refuses a target that already has data, and one at a different schema, and says why", async () => {
    const dst = await fresh("dst-5");
    await importData(dst, exportDir);
    await assert.rejects(importData(dst, exportDir), /target is not empty: .*users/);
    const behind = await fresh("dst-6");
    await behind.query(`delete from drizzle.__drizzle_migrations where id = (select max(id) from drizzle.__drizzle_migrations)`);
    await assert.rejects(importData(behind, exportDir), /migrations .* are not the export's/);
    assert.equal((await snapshot(behind.query)).tables.every((t) => t.rows === 0), true, "nothing was loaded");
  });

  test("a failure part-way leaves the target empty, so the import can simply be run again", async () => {
    const broken = path.join(work, "export-broken");
    fs.cpSync(exportDir, broken, { recursive: true });
    fs.appendFileSync(path.join(broken, "tickets.ndjson"), '{"id":"not-a-uuid"}\n'); // users, workspaces, teams… load first; this fails later
    const dst = await fresh("dst-7");
    await assert.rejects(importData(dst, broken));
    assert.equal((await snapshot(dst.query)).tables.every((t) => t.rows === 0), true);
    await importData(dst, exportDir); // and the good export still goes in
  });

  test("an export refuses to write over an earlier one", async () => {
    const src = await track(openConn(copyDirToTemp(source)));
    await assert.rejects(exportData(src.query, exportDir, "again"), /already holds an export/);
  });

  test("tables come parents-first, and the app's own 31 tables are all there", async () => {
    const src = await track(openConn(copyDirToTemp(source)));
    const order = await tablesInOrder(src.query);
    assert.equal(order.length, 31);
    const at = (n: string) => order.findIndex((t) => t.name === n);
    for (const t of order) for (const p of t.parents) assert.ok(at(p) < at(t.name), `${p} before ${t.name}`);
  });
});

describe("verification notices a mistake", () => {
  const manifest = () => JSON.parse(fs.readFileSync(path.join(exportDir, "manifest.json"), "utf8"));
  const imported = async (name: string) => {
    const dst = await fresh(name);
    await importData(dst, exportDir);
    return dst;
  };
  const errors = async (dst: Conn) => compare(manifest().snapshot, await snapshot(dst.query)).filter((f) => f.level === "error");

  test("an edited ticket, a deleted API key, a changed hash, an extra row and a moved sequence are each found, by table", async () => {
    const dst = await imported("v-1");
    assert.deepEqual(await errors(dst), []);
    await dst.query(`update tickets set title = title || ' (edited)'`);
    assert.match((await errors(dst)).map((e) => `${e.check}: ${e.detail}`).join("\n"), /table tickets: same row count \(1\) but the content differs/);
    await dst.query(`update api_keys set key_hash = repeat('c', 64)`);
    assert.ok((await errors(dst)).some((e) => e.check === "table api_keys"));
    await dst.query(`delete from agent_cursors`);
    assert.ok((await errors(dst)).some((e) => e.check === "table agent_cursors" && /1 rows expected, 0 found/.test(e.detail)));
    await dst.query(`insert into terms (team_id, term, definition) select id, 'extra', 'x' from teams`);
    assert.ok((await errors(dst)).some((e) => e.check === "table terms" && /expected, .* found/.test(e.detail)));
    await dst.query(`select setval('events_seq_seq', 5)`);
    assert.ok((await errors(dst)).some((e) => e.check === "sequence events_seq_seq"));
  });

  test("integrity: clean data passes; an orphan, a cursor ahead of the newest event, and a bad credential are reported", async () => {
    const dst = await imported("v-2");
    assert.deepEqual((await integrity(dst.query)).filter((f) => f.level === "error"), []);
    await dst.query(`set session_replication_role = replica`); // switches the foreign key triggers off, so a row can be written that the constraint would refuse
    await dst.query(`insert into comments (ticket_id, author_kind, author_name, body) values (gen_random_uuid(), 'human', 'x', 'orphan')`);
    await dst.query(`set session_replication_role = origin`);
    await dst.query(`update agent_cursors set last_seq = (select max(seq) + 10 from events)`);
    await dst.query(`update api_keys set key_hash = 'plaintext-secret'`);
    await dst.query(`select setval('events_seq_seq', 1)`);
    const bad = (await integrity(dst.query)).filter((f) => f.level === "error").map((f) => f.check);
    assert.ok(bad.some((c) => c.startsWith("foreign key")), "orphan");
    assert.ok(bad.includes("agent_cursors.last_seq"), "cursor");
    assert.ok(bad.includes("api_keys"), "credential");
    assert.ok(bad.includes("events.seq"), "sequence behind the newest event");
  });
});

describe("the command line", () => {
  const cli = (...a: string[]) => spawnSync("pnpm", ["exec", "tsx", path.resolve(import.meta.dirname, "db-cli.ts"), ...a], { encoding: "utf8", cwd: path.resolve(import.meta.dirname, "..", "..") });

  test("export, import and verify run unattended and agree; the source directory is not touched", () => {
    const before = fs.readdirSync(source, { recursive: true }).map(String).sort().map((f) => `${f}:${fs.statSync(path.join(source, f)).mtimeMs}`);
    const out = path.join(work, "cli-export");
    const e = cli("export", "--from", source, "--out", out);
    assert.equal(e.status, 0, e.stderr + e.stdout);
    assert.match(e.stdout, /exported 31 tables/);
    const after = fs.readdirSync(source, { recursive: true }).map(String).sort().map((f) => `${f}:${fs.statSync(path.join(source, f)).mtimeMs}`);
    assert.deepEqual(after, before, "the source was only copied, never opened");
    const target = path.join(work, "cli-target");
    const i = cli("import", "--in", out, "--to", target);
    assert.equal(i.status, 0, i.stderr + i.stdout);
    const v = cli("verify", "--in", out, "--to", target);
    assert.equal(v.status, 0, v.stdout + v.stderr);
    assert.match(v.stdout, /RESULT: everything agrees/);
    const live = cli("verify", "--from", source, "--to", target);
    assert.equal(live.status, 0, live.stdout + live.stderr);
  });

  test("verify exits non-zero and says what differs; a second import into the same target is refused", () => {
    const out = path.join(work, "cli-export");
    const target = path.join(work, "cli-target");
    const again = cli("import", "--in", out, "--to", target);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /target is not empty/);
    fs.appendFileSync(path.join(out, "manifest.json"), "");
    const m = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
    m.snapshot.tables.find((t: { name: string }) => t.name === "tickets").md5 = "0".repeat(32);
    fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(m));
    const v = cli("verify", "--in", out, "--to", target);
    assert.equal(v.status, 1);
    assert.match(v.stdout, /FAIL table tickets/);
    assert.match(v.stdout, /DISCREPANCIES FOUND/);
  });

  test("a missing argument is a usage message, not a stack trace", () => {
    const r = cli("export");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--from is required/);
  });
});

if (process.env.TEST_DATABASE_URL) {
  describe("PGlite to Postgres and back (a real Postgres)", () => {
    const postgres = require("postgres") as typeof import("postgres");
    const base = process.env.TEST_DATABASE_URL!;
    const scratch = `wh_copy_${Math.random().toString(16).slice(2, 8)}`;
    const urlFor = (db: string) => base.replace(/\/[^/?]+(\?|$)/, `/${db}$1`);
    let admin: ReturnType<typeof postgres>;
    before(async () => {
      admin = postgres(base, { max: 1 });
      await admin.unsafe(`create database ${scratch}`);
    });
    after(async () => {
      await admin.unsafe(`drop database if exists ${scratch} with (force)`).catch(() => {});
      await admin.end();
    });

    test("the same checksums on both engines, then back again into PGlite", async () => {
      const pg = await track(openConn(urlFor(scratch), { migrate: true }));
      await importData(pg, exportDir);
      const manifest = JSON.parse(fs.readFileSync(path.join(exportDir, "manifest.json"), "utf8"));
      assert.deepEqual(compare(manifest.snapshot, await snapshot(pg.query)).filter((f) => f.level === "error"), [], "Postgres holds what PGlite exported");
      assert.deepEqual((await integrity(pg.query)).filter((f) => f.level === "error"), []);
      const back = path.join(work, "export-from-pg");
      await exportData(pg.query, back, "postgres");
      const lite = await fresh("from-pg");
      await importData(lite, back);
      const again = JSON.parse(fs.readFileSync(path.join(back, "manifest.json"), "utf8"));
      assert.deepEqual(compare(again.snapshot, await snapshot(lite.query)).filter((f) => f.level === "error"), []);
      assert.deepEqual(compare(manifest.snapshot, await snapshot(lite.query)).filter((f) => f.level === "error"), [], "and PGlite → Postgres → PGlite is the identity");
    });
  });
}
