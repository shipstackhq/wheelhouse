import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { schema } from "../db";
import { ServiceError } from "./service-error";
import type { Q } from "./service";

/**
 * Labels on issues, nodes an ADR applies to, and teams an invite puts someone in were JSON arrays; they are rows now
 * (WH-115), so the database checks them and a delete removes them. These functions read and write those rows and hand
 * back the arrays the rest of the code, the web app and the MCP always saw.
 */

const { labels, issueLabels, decisionNodes } = schema;
type TeamRef = { id: string; workspaceId: string };

// ───────── labels ─────────

/** Labels as stored: trimmed, no empties or repeats (case-insensitively, first spelling wins), at most 20 of at most 40 characters. */
export function cleanLabels(input: string[], what = "issue"): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const l = raw.trim().replace(/\s+/g, " ");
    if (!l || seen.has(l.toLowerCase())) continue;
    if (l.length > 40) throw new ServiceError("invalid", `A label is at most 40 characters ("${l.slice(0, 20)}…")`);
    seen.add(l.toLowerCase());
    out.push(l);
  }
  if (out.length > 20) throw new ServiceError("invalid", `A ${what} has at most 20 labels`);
  return out;
}

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

// ───────── cycles ─────────

/** Rows of issues with the `cycle` number they are in (null when in none). */
export async function withCycle<T extends { cycleId: string | null }>(q: Q, rows: T[]): Promise<(T & { cycle: number | null })[]> {
  const ids = [...new Set(rows.map((r) => r.cycleId).filter((x): x is string => !!x))];
  const numbers = ids.length ? new Map((await q.select({ id: schema.cycles.id, number: schema.cycles.number }).from(schema.cycles).where(inArray(schema.cycles.id, ids))).map((c) => [c.id, c.number])) : new Map<string, number>();
  return rows.map((r) => ({ ...r, cycle: r.cycleId ? (numbers.get(r.cycleId) ?? null) : null }));
}

// ───────── decisions ─────────

/** The nodes each ADR applies to. */
export async function nodeIdsOf(q: Q, decisionIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(decisionIds.map((id) => [id, []]));
  if (!decisionIds.length) return out;
  const rows = await q
    .select({ decisionId: decisionNodes.decisionId, nodeId: decisionNodes.nodeId, name: schema.nodes.name })
    .from(decisionNodes)
    .innerJoin(schema.nodes, eq(schema.nodes.id, decisionNodes.nodeId))
    .where(inArray(decisionNodes.decisionId, decisionIds))
    .orderBy(asc(schema.nodes.name), asc(schema.nodes.id));
  for (const r of rows) out.get(r.decisionId)!.push(r.nodeId);
  return out;
}

/** Rows of decisions with their `nodeIds` on them. */
export async function withNodeIds<T extends { id: string }>(q: Q, rows: T[]): Promise<(T & { nodeIds: string[] })[]> {
  const map = await nodeIdsOf(q, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, nodeIds: map.get(r.id) ?? [] }));
}

/** Make an ADR apply to exactly these nodes (already resolved, and of the team: the foreign keys refuse anything else). */
export async function setDecisionNodes(q: Q, team: TeamRef, decisionId: string, nodeIds: string[]) {
  const ids = [...new Set(nodeIds)];
  await q.delete(decisionNodes).where(and(eq(decisionNodes.decisionId, decisionId), ids.length ? notInArray(decisionNodes.nodeId, ids) : undefined));
  if (ids.length) {
    await q
      .insert(decisionNodes)
      .values(ids.map((nodeId) => ({ decisionId, nodeId, teamId: team.id, workspaceId: team.workspaceId })))
      .onConflictDoNothing();
  }
}
