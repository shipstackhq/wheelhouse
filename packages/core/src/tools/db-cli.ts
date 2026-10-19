import fs from "node:fs";
import path from "node:path";
import { compare, copyDirToTemp, exportData, importData, integrity, openConn, snapshot, type Finding, type Manifest, type Snapshot } from "./db-copy";

/**
 * pnpm db:migrate --to <PGlite directory | postgres://…>                  (bring a database to this code's migrations; do it to a COPY before exporting)
 * pnpm db:export --from <PGlite directory | postgres://…> --out <folder>
 * pnpm db:import --in <folder> --to <PGlite directory | postgres://…>      (the target is migrated first and must then be empty)
 * pnpm db:verify --in <folder> --to <target>                               (the target against what the export said)
 * pnpm db:verify --from <source> --to <target>                             (two live databases; a PGlite source is copied first)
 * pnpm db:verify --to <target> --integrity-only                            (only what must be true of any Wheelhouse database)
 *
 * Exit status 0 means everything agreed. Nothing here writes to a source, and an import is all or nothing. The runbook is docs/cutover.md.
 */

const args = process.argv.slice(2);
const command = args[0];
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name: string) => args.includes(`--${name}`);
const need = (name: string) => opt(name) ?? usage(`--${name} is required`);

function usage(problem?: string): never {
  if (problem) console.error(problem + "\n");
  console.error(`usage:
  db:migrate --to <PGlite dir | postgres url>      (apply this code's migrations to it; run on a copy of the source before exporting)
  db:export --from <PGlite dir | postgres url> --out <folder> [--in-place]
  db:import --in <folder> --to <PGlite dir | postgres url>
  db:verify --in <folder> --to <target>      or      db:verify --from <source> --to <target>   [--json]`);
  process.exit(2);
}

const log = (s: string) => console.log(s);
const secs = (n: number) => `${n.toFixed(1)}s`;

function report(findings: Finding[], json: boolean) {
  if (json) console.log(JSON.stringify(findings, null, 2));
  else for (const f of findings) log(`  ${f.level === "error" ? "FAIL" : "ok  "} ${f.check}: ${f.detail}`);
  return findings.some((f) => f.level === "error");
}

async function main() {
  if (command === "migrate") {
    // The export refuses to cross migrations (an import is checked against the export's), so a source made by older code is
    // brought up to this code's first. Never point this at the live database: copy it, and migrate the copy.
    const to = need("to");
    const conn = await openConn(to, { migrate: true });
    const [{ n }] = (await conn.query("select count(*)::int as n from drizzle.__drizzle_migrations")) as { n: number }[];
    await conn.close();
    log(`${to} is at ${n} migrations (this code's)`);
    return 0;
  }
  if (command === "export") {
    const from = need("from");
    const out = need("out");
    const t0 = Date.now();
    // A PGlite directory belongs to one process and opening it can rewrite files, so work on a copy: the original is never opened.
    const isDir = !/^postgres(ql)?:\/\//i.test(from) && !from.startsWith("memory://");
    const dir = isDir && !flag("in-place") ? copyDirToTemp(from) : from;
    if (dir !== from) log(`copied ${from} to a private working copy (the original is not opened)`);
    const conn = await openConn(dir);
    try {
      const r = await exportData(conn.query, out, conn.label === dir ? from : conn.label);
      const rows = r.manifest.snapshot.tables.reduce((n, t) => n + t.rows, 0);
      log(`exported ${r.manifest.snapshot.tables.length} tables, ${rows} rows to ${path.resolve(out)} in ${secs(r.seconds)} (total ${secs((Date.now() - t0) / 1000)})`);
    } finally {
      await conn.close();
      if (dir !== from) fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    }
    return 0;
  }

  if (command === "import") {
    const dir = need("in");
    const to = need("to");
    const conn = await openConn(to, { migrate: true, create: true });
    try {
      const r = await importData(conn, dir);
      log(`imported ${r.tables.reduce((n, t) => n + t.rows, 0)} rows into ${conn.label} in ${secs(r.seconds)}`);
      for (const t of r.tables.filter((t) => t.rows)) log(`  ${t.name.padEnd(22)} ${t.rows}`);
    } finally {
      await conn.close();
    }
    return 0;
  }

  if (command === "verify" && flag("integrity-only")) {
    const conn = await openConn(need("to"));
    try {
      log(`checking ${conn.label} (integrity only)`);
      const failed = report(await integrity(conn.query), flag("json"));
      log(failed ? "RESULT: PROBLEMS FOUND" : "RESULT: integrity holds");
      return failed ? 1 : 0;
    } finally {
      await conn.close();
    }
  }

  if (command === "verify") {
    const to = need("to");
    const json = flag("json");
    let expected: Snapshot;
    let what: string;
    if (opt("in")) {
      const manifest = JSON.parse(fs.readFileSync(path.join(opt("in")!, "manifest.json"), "utf8")) as Manifest;
      expected = manifest.snapshot;
      what = `the export at ${opt("in")} (from ${manifest.source}, ${manifest.createdAt})`;
    } else {
      const from = need("from");
      const isDir = !/^postgres(ql)?:\/\//i.test(from) && !from.startsWith("memory://");
      const dir = isDir ? copyDirToTemp(from) : from;
      const src = await openConn(dir);
      try {
        expected = await snapshot(src.query);
      } finally {
        await src.close();
        if (dir !== from) fs.rmSync(path.dirname(dir), { recursive: true, force: true });
      }
      what = `the source ${from}`;
    }
    const conn = await openConn(to);
    try {
      log(`checking ${conn.label} against ${what}`);
      const actual = await snapshot(conn.query);
      const failed = report([...compare(expected, actual), ...(await integrity(conn.query))], json);
      log(failed ? "RESULT: DISCREPANCIES FOUND" : "RESULT: everything agrees");
      return failed ? 1 : 0;
    } finally {
      await conn.close();
    }
  }

  return usage();
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`error: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  },
);
