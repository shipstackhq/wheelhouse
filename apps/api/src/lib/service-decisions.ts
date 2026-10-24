import { and, asc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "../db";
import type { Actor } from "./access";
import { ServiceError } from "./service-error";
import { setDecisionNodes, withNodeIds } from "./links";
import { diff, emit, isUuid } from "./service-core";
import { resolveNode } from "./service-map";
import { requireTeam } from "../modules/teams/teams";

const { decisions, terms } = schema;

// ───────── decisions ─────────

export type DecisionInput = {
  number?: number;
  title?: string;
  status?: (typeof schema.DECISION_STATUSES)[number];
  context?: string;
  decision?: string;
  consequences?: string;
  nodes?: string[];
  /** Optimistic lock, as on nodes: the decision version the caller last read (updates only). */
  expectedVersion?: number;
};

export async function listDecisions(actor: Actor, teamRef: string) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef);
  return withNodeIds(db, await db.select().from(decisions).where(eq(decisions.teamId, team.id)).orderBy(asc(decisions.number)));
}

/** Create (no number) or update (number) an ADR. */
export async function upsertDecision(actor: Actor, teamRef: string, input: DecisionInput) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  return db.transaction(async (tx) => {
    const nodeIds = input.nodes ? await Promise.all(input.nodes.map(async (r) => (await resolveNode(tx, team.id, r)).id)) : undefined;
    if (input.number !== undefined) {
      const [d] = await tx.select().from(decisions).where(and(eq(decisions.teamId, team.id), eq(decisions.number, input.number))).for("update");
      if (!d) throw new ServiceError("not_found", `Decision ADR-${input.number} not found`);
      if (input.expectedVersion !== undefined && input.expectedVersion !== d.version) {
        throw new ServiceError("conflict", `ADR-${d.number} was changed (version ${d.version}, you had ${input.expectedVersion}). Re-read and retry.`, { current: (await withNodeIds(tx, [d]))[0] });
      }
      const [current] = await withNodeIds(tx, [d]);
      const patch = {
        title: input.title,
        status: input.status,
        context: input.context,
        decision: input.decision,
        consequences: input.consequences,
        nodeIds,
      };
      const changes = diff(current as unknown as Record<string, unknown>, patch as Record<string, unknown>);
      if (!Object.keys(changes).length) return current;
      const { nodeIds: newNodes, ...columnsPatch } = patch;
      const [row] = await tx
        .update(decisions)
        .set({ ...Object.fromEntries(Object.entries(columnsPatch).filter(([, v]) => v !== undefined)), version: d.version + 1, updatedAt: new Date() })
        .where(eq(decisions.id, d.id))
        .returning();
      if (newNodes) await setDecisionNodes(tx, team, row.id, newNodes);
      const u = { ...row, nodeIds: newNodes ?? current.nodeIds };
      await emit(tx, actor, team.id, {
        type: "decision.updated",
        entity: "decision",
        entityId: u.id,
        summary: `updated ADR-${u.number} "${u.title}": ${Object.keys(changes).join(", ")}`,
        data: { number: u.number },
      });
      return u;
    }
    if (!input.title?.trim()) throw new ServiceError("invalid", "title is required");
    const [{ max }] = await tx
      .select({ max: sql<number>`coalesce(max(${decisions.number}), 0)::int` })
      .from(decisions)
      .where(eq(decisions.teamId, team.id));
    const [d] = await tx
      .insert(decisions)
      .values({
        teamId: team.id,
        workspaceId: team.workspaceId,
        number: Number(max) + 1,
        title: input.title.trim(),
        status: input.status ?? "accepted",
        context: input.context ?? "",
        decision: input.decision ?? "",
        consequences: input.consequences ?? "",
        authorKind: actor.kind,
        authorName: actor.name,
      })
      .returning();
    await setDecisionNodes(tx, team, d.id, nodeIds ?? []);
    await emit(tx, actor, team.id, {
      type: "decision.created",
      entity: "decision",
      entityId: d.id,
      summary: `recorded ADR-${d.number} "${d.title}"`,
      data: { number: d.number },
    });
    return { ...d, nodeIds: [...new Set(nodeIds ?? [])] };
  });
}

// ───────── glossary ─────────

export async function listTerms(actor: Actor, teamRef: string) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef);
  return db.select().from(terms).where(eq(terms.teamId, team.id)).orderBy(asc(terms.term));
}

export async function upsertTerm(actor: Actor, teamRef: string, input: { term: string; definition: string; node?: string | null }) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  const term = input.term?.trim();
  if (!term || !input.definition?.trim()) throw new ServiceError("invalid", "term and definition are required");
  return db.transaction(async (tx) => {
    const nodeId = input.node === null ? null : input.node ? (await resolveNode(tx, team.id, input.node)).id : undefined;
    const [existing] = await tx
      .select()
      .from(terms)
      .where(and(eq(terms.teamId, team.id), eq(sql`lower(${terms.term})`, term.toLowerCase())));
    if (existing) {
      if (existing.definition === input.definition.trim() && (nodeId === undefined || nodeId === existing.nodeId) && existing.term === term) return existing;
      const [t] = await tx
        .update(terms)
        .set({ term, definition: input.definition.trim(), ...(nodeId !== undefined ? { nodeId } : {}), updatedAt: new Date() })
        .where(eq(terms.id, existing.id))
        .returning();
      await emit(tx, actor, team.id, { type: "term.updated", entity: "term", entityId: t.id, summary: `updated glossary term "${t.term}"` });
      return t;
    }
    const [t] = await tx
      .insert(terms)
      .values({ teamId: team.id, workspaceId: team.workspaceId, term, definition: input.definition.trim(), nodeId: nodeId ?? null })
      .returning();
    await emit(tx, actor, team.id, { type: "term.created", entity: "term", entityId: t.id, summary: `defined glossary term "${t.term}"` });
    return t;
  });
}

export async function deleteTerm(actor: Actor, teamRef: string, term: string) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  const [t] = await db
    .select()
    .from(terms)
    .where(and(eq(terms.teamId, team.id), isUuid(term) ? eq(terms.id, term) : eq(sql`lower(${terms.term})`, term.toLowerCase())));
  if (!t) throw new ServiceError("not_found", `Term "${term}" not found`);
  await db.delete(terms).where(eq(terms.id, t.id));
  await emit(db, actor, team.id, { type: "term.deleted", entity: "term", entityId: t.id, summary: `removed glossary term "${t.term}"` });
  return { ok: true };
}
