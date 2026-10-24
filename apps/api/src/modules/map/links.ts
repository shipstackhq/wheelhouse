import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import { schema } from "../../db";
import type { Q } from "../../platform/database/transaction";

/** The nodes an ADR applies to are rows (WH-115): the database checks them and a delete removes them. */

const { decisionNodes } = schema;
type TeamRef = { id: string; workspaceId: string };

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
