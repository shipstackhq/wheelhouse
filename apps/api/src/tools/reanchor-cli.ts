import fs from "node:fs";
import path from "node:path";
import { copyDirToTemp, openConn } from "./db-copy";
import { formatReport, gitTree, reanchor, type Rules } from "./reanchor";

/**
 * pnpm map:reanchor --db <PGlite directory | postgres://…> --from <git ref> --to <git ref> --rules <file> [--repo <git dir>] [--apply]
 *
 * Without --apply it only reports (a PGlite directory is copied first, so even the original is not opened). With --apply it rewrites the anchors
 * and baselines of one team's nodes and docs in that database: run it on the IMPORTED copy, before the new app starts (docs/cutover.md).
 * Exit status is non-zero if any anchor could not be mapped, so it can gate a cutover.
 */
const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const need = (n: string) =>
  opt(n) ??
  (() => {
    console.error(`--${n} is required\n\nusage: map:reanchor --db <dir|url> --from <ref> --to <ref> --rules <file> [--repo <git dir>] [--apply]`);
    process.exit(2);
  })();

async function main() {
  const db = need("db");
  const apply = args.includes("--apply");
  const rules = JSON.parse(fs.readFileSync(need("rules"), "utf8")) as Rules;
  const tree = gitTree(path.resolve(opt("repo") ?? process.cwd()), need("from"), need("to"));
  const isDir = !/^postgres(ql)?:\/\//i.test(db) && !db.startsWith("memory://");
  const dir = isDir && !apply ? copyDirToTemp(db) : db;
  const conn = await openConn(dir);
  try {
    const report = await reanchor(conn.query, tree, rules, { apply });
    console.log(formatReport(report));
    console.log(`\n${tree.oldFiles.length} files at ${need("from")}, ${tree.newFiles.length} at ${need("to")}, ${tree.renames.size} renames.`);
    return report.unresolved.length ? 1 : 0;
  } finally {
    await conn.close();
    if (dir !== db) fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error(`error: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  },
);
