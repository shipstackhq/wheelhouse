// The migration gate (docs: "Staging deploys: plan and runbook"). Drizzle applies, on start, every migration newer than the newest
// one recorded, all in one transaction, so two things can go wrong without an error: a migration whose timestamp is not later
// than the one before it is skipped for good, and a destructive one breaks the previous image that a failed deploy rolls back to.
// An edit to a migration that already ran is a third: it never runs again.
//   tsx scripts/check-migrations.ts [<base commit>]
// Always checks the order of the whole journal; with a base, also checks the migrations added or changed since it. A destructive migration
// passes only when its file says why, on a line of its own: `-- destructive: <reason>`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const DIR = "apps/api/drizzle";

const DESTRUCTIVE: [RegExp, string][] = [
  [/\bDROP\s+(TABLE|COLUMN|SCHEMA|TYPE|VIEW)\b/i, "drops something"],
  [/\bRENAME\b/i, "renames something"],
  [/\bALTER\s+COLUMN\s+"?\w+"?\s+(SET\s+DATA\s+)?TYPE\b/i, "changes a column's type"],
  [/\bSET\s+NOT\s+NULL\b/i, "makes a column required"],
  [/\bADD\s+COLUMN\b(?![^;]*\bDEFAULT\b)[^;]*\bNOT\s+NULL\b/i, "adds a required column with no default"],
  [/\bTRUNCATE\b/i, "empties a table"],
  [/\bDELETE\s+FROM\b/i, "deletes rows"],
];

/** Journal entries whose timestamp is not later than the entry before them: Drizzle would skip them where the earlier one is applied. */
export function outOfOrder(entries: { tag: string; when: number }[]): string[] {
  return entries.flatMap((e, i) => (i > 0 && e.when <= entries[i - 1].when ? [`${e.tag} is not newer than ${entries[i - 1].tag}`] : []));
}

/** Why a migration's SQL is destructive, or nothing when it is additive or says why it may be destructive. */
export function destructive(sql: string): string[] {
  if (/^--\s*destructive:\s*\S/m.test(sql)) return [];
  const statements = sql.split(/-->\s*statement-breakpoint|;/).map((s) => s.replace(/^--.*$/gm, ""));
  return [...new Set(statements.flatMap((s) => DESTRUCTIVE.filter(([re]) => re.test(s)).map(([, why]) => why)))];
}

if (process.argv[1]?.endsWith("check-migrations.ts")) {
  const base = process.argv[2];
  const journal = JSON.parse(readFileSync(`${DIR}/meta/_journal.json`, "utf8")) as { entries: { tag: string; when: number }[] };
  const problems = outOfOrder(journal.entries);
  if (base) {
    const changed = (filter: string) => execFileSync("git", ["diff", "--name-only", `--diff-filter=${filter}`, base, "--", `${DIR}/*.sql`], { encoding: "utf8" }).split("\n").filter(Boolean);
    const added = changed("A");
    for (const file of added) for (const why of destructive(readFileSync(file, "utf8"))) problems.push(`${file} ${why}; if that is intended, add a line "-- destructive: <reason>"`);
    // A database that already applied a migration never runs it again, so an edit to one reaches only fresh databases.
    for (const file of changed("MD")) problems.push(`${file} was changed or removed; write a new migration instead`);
    console.log(`checked the order of ${journal.entries.length} migrations and ${added.length} new since ${base.slice(0, 7)}`);
  } else console.log(`checked the order of ${journal.entries.length} migrations (no base given, so no new ones were checked)`);
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(problems.length ? 1 : 0);
}
