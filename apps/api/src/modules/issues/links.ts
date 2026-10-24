import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { schema } from "../../db";
import type { Q } from "../../platform/database/transaction";
import { cleanLabels } from "../../common/labels";

/**
 * Labels on issues, as rows (WH-115): the database checks them and a delete removes them. These functions read and write those
 * rows and hand back the arrays the rest of the code, the web app and the MCP always saw. The cycle number of an issue too.
 */

const { labels, issueLabels } = schema;
type TeamRef = { id: string; workspaceId: string };

/** The label names on each issue, alphabetical (the join has no order of its own). */
export async function labelsOf(q: Q, issueIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(issueIds.map((id) => [id, []]));
  if (!issueIds.length) return out;
  const rows = await q
    .select({ issueId: issueLabels.issueId, name: labels.name })
    .from(issueLabels)
    .innerJoin(labels, eq(labels.id, issueLabels.labelId))
    .where(inArray(issueLabels.issueId, issueIds))
    .orderBy(asc(sql`lower(${labels.name})`));
  for (const r of rows) out.get(r.issueId)!.push(r.name);
  return out;
}

/** Rows of issues with their `labels` names on them. */
export async function withLabels<T extends { id: string }>(q: Q, rows: T[]): Promise<(T & { labels: string[] })[]> {
  const map = await labelsOf(q, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, labels: map.get(r.id) ?? [] }));
}

/** Make an issue carry exactly these label names, creating the team's labels that do not exist yet (a name matches in any case). */
export async function setIssueLabels(q: Q, team: TeamRef, issueId: string, names: string[]) {
  const want = cleanLabels(names);
  if (want.length) {
    await q
      .insert(labels)
      .values(want.map((name) => ({ teamId: team.id, workspaceId: team.workspaceId, name })))
      .onConflictDoNothing();
  }
  const rows = want.length
    ? await q
        .select({ id: labels.id })
        .from(labels)
        .where(and(eq(labels.teamId, team.id), inArray(sql`lower(${labels.name})`, want.map((n) => n.toLowerCase()))))
    : [];
  const ids = rows.map((r) => r.id);
  await q.delete(issueLabels).where(and(eq(issueLabels.issueId, issueId), ids.length ? notInArray(issueLabels.labelId, ids) : undefined));
  if (ids.length) {
    await q
      .insert(issueLabels)
      .values(ids.map((labelId) => ({ issueId, labelId, teamId: team.id, workspaceId: team.workspaceId })))
      .onConflictDoNothing();
  }
}

/** Rows of issues with the `cycle` number they are in (null when in none). */
export async function withCycle<T extends { cycleId: string | null }>(q: Q, rows: T[]): Promise<(T & { cycle: number | null })[]> {
  const ids = [...new Set(rows.map((r) => r.cycleId).filter((x): x is string => !!x))];
  const numbers = ids.length ? new Map((await q.select({ id: schema.cycles.id, number: schema.cycles.number }).from(schema.cycles).where(inArray(schema.cycles.id, ids))).map((c) => [c.id, c.number])) : new Map<string, number>();
  return rows.map((r) => ({ ...r, cycle: r.cycleId ? (numbers.get(r.cycleId) ?? null) : null }));
}
