import path from "node:path";
import fs from "node:fs";

/**
 * pnpm map:after-migration --db <PGlite directory | postgres://…>
 * Brings the map's descriptions up to date with the new architecture (see post-migration-map.ts). Run on the IMPORTED data, after
 * `pnpm map:reanchor --apply`, before the new app starts. Prints what it changed and what it left alone.
 */
const i = process.argv.indexOf("--db");
const db = i >= 0 ? process.argv[i + 1] : undefined;
if (!db) {
  console.error("usage: map:after-migration --db <PGlite directory | postgres url>");
  process.exit(2);
}
if (/^postgres(ql)?:\/\//i.test(db)) process.env.DATABASE_URL = db;
else {
  if (!fs.existsSync(path.join(db, "PG_VERSION"))) {
    console.error(`${db} is not a PGlite data directory`);
    process.exit(2);
  }
  delete process.env.DATABASE_URL;
  process.env.PGLITE_DIR = path.resolve(db);
}
async function main() {
  const { postMigrationMap } = await import("./post-migration-map");
  const { closeDb } = await import("../db");
  try {
    const r = await postMigrationMap();
    for (const d of r.did) console.log(`  done    ${d}`);
    for (const s of r.skipped) console.log(`  skipped ${s}`);
    if (!r.did.length) console.log("  nothing to change: the map already says this");
    await closeDb();
    return 0;
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : e}`);
    await closeDb().catch(() => {});
    return 1;
  }
}

main().then((code) => process.exit(code));
