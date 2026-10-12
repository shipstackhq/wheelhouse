import "server-only";
import { and, asc, desc, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import { getDb, schema, type DB } from "@/db";
import type { Actor } from "./auth";

/**
 * The single write path for Wheelhouse. UI server actions, the REST API and the
 * MCP server all call into here, so every mutation is team-scoped, versioned
 * where it matters, and recorded in `events` (the activity feed + AI queue).
 */

const { projects, columns, tickets, comments, nodes, edges, ticketNodes, events, agentCursors } = schema;

export class ServiceError extends Error {
  constructor(
    public code: "not_found" | "conflict" | "invalid" | "forbidden",
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
  get status() {
    return { not_found: 404, conflict: 409, invalid: 400, forbidden: 403 }[this.code];
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: string) => UUID_RE.test(s);

export const DEFAULT_COLUMNS = ["Backlog", "Todo", "In Progress", "Review", "Done"];

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
type Q = DB | Tx;

async function emit(
  q: Q,
  actor: Actor,
  projectId: string,
  e: { type: string; entity: (typeof events.$inferInsert)["entity"]; entityId: string; summary: string; data?: Record<string, unknown> },
) {
  await q.insert(events).values({
    teamId: actor.teamId,
    projectId,
    actorKind: actor.kind,
    actorId: actor.id,
    actorName: actor.name,
    type: e.type,
    entity: e.entity,
    entityId: e.entityId,
    summary: e.summary,
    data: e.data ?? {},
  });
}

/** Shallow diff for event payloads: { field: { from, to } } */
function diff<T extends Record<string, unknown>>(before: T, patch: Partial<T>) {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(patch)) {
    const a = before[k];
    const b = patch[k as keyof T];
    if (b !== undefined && JSON.stringify(a) !== JSON.stringify(b)) out[k] = { from: a, to: b };
  }
  return out;
}

// ───────────────────────── projects ─────────────────────────

export async function listProjects(actor: Actor) {
  const db = await getDb();
  return db.select().from(projects).where(eq(projects.teamId, actor.teamId)).orderBy(asc(projects.createdAt));
}

/** Accepts a project uuid or its key (e.g. "WH"). */
export async function getProject(actor: Actor, ref: string) {
  const db = await getDb();
  const [p] = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.teamId, actor.teamId),
        isUuid(ref) ? eq(projects.id, ref) : eq(sql`upper(${projects.key})`, ref.toUpperCase()),
      ),
    );
  if (!p) throw new ServiceError("not_found", `Project ${ref} not found`);
  return p;
}

export async function createProject(actor: Actor, input: { name: string; key?: string; description?: string }) {
  const db = await getDb();
  const name = input.name.trim();
  if (!name) throw new ServiceError("invalid", "Project name is required");
  const key = (input.key || name.replace(/[^a-zA-Z]/g, "").slice(0, 3) || "PRJ").toUpperCase().slice(0, 6);
  const existing = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.teamId, actor.teamId), eq(projects.key, key)));
  if (existing.length) throw new ServiceError("conflict", `Project key ${key} already in use`);

  return db.transaction(async (tx) => {
    const [p] = await tx
      .insert(projects)
      .values({ teamId: actor.teamId, name, key, description: input.description ?? "" })
      .returning();
    await tx.insert(columns).values(DEFAULT_COLUMNS.map((n, i) => ({ projectId: p.id, name: n, position: i + 1 })));
    await emit(tx, actor, p.id, { type: "project.created", entity: "project", entityId: p.id, summary: `created project ${p.name}` });
    return p;
  });
}

// ───────────────────────── board / tickets ─────────────────────────

export type TicketWithLinks = typeof tickets.$inferSelect & { ref: string; nodeIds: string[]; commentCount: number };

export async function getBoard(actor: Actor, projectRef: string) {
  const db = await getDb();
  const project = await getProject(actor, projectRef);
  const cols = await db.select().from(columns).where(eq(columns.projectId, project.id)).orderBy(asc(columns.position));
  const ts = await db.select().from(tickets).where(eq(tickets.projectId, project.id)).orderBy(asc(tickets.position));
  const ids = ts.map((t) => t.id);
  const links = ids.length ? await db.select().from(ticketNodes).where(inArray(ticketNodes.ticketId, ids)) : [];
  const counts = ids.length
    ? await db
        .select({ ticketId: comments.ticketId, n: sql<number>`count(*)::int` })
        .from(comments)
        .where(inArray(comments.ticketId, ids))
        .groupBy(comments.ticketId)
    : [];
  const countMap = new Map(counts.map((c) => [c.ticketId, Number(c.n)]));
  const withLinks: TicketWithLinks[] = ts.map((t) => ({
    ...t,
    ref: `${project.key}-${t.number}`,
    nodeIds: links.filter((l) => l.ticketId === t.id).map((l) => l.nodeId),
    commentCount: countMap.get(t.id) ?? 0,
  }));
  return { project, columns: cols, tickets: withLinks };
}

async function resolveColumn(q: Q, projectId: string, ref: string) {
  const cols = await q.select().from(columns).where(eq(columns.projectId, projectId)).orderBy(asc(columns.position));
  const c = cols.find((c) => c.id === ref) ?? cols.find((c) => c.name.toLowerCase() === ref.toLowerCase());
  if (!c) throw new ServiceError("invalid", `Unknown column "${ref}". Valid: ${cols.map((c) => c.name).join(", ")}`);
  return c;
}

/** Accepts a ticket uuid or a ref like "WH-12". */
export async function resolveTicket(actor: Actor, ref: string, q?: Q) {
  const db = q ?? (await getDb());
  let row: { t: typeof tickets.$inferSelect; p: typeof projects.$inferSelect } | undefined;
  if (isUuid(ref)) {
    [row] = await db
      .select({ t: tickets, p: projects })
      .from(tickets)
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .where(and(eq(tickets.id, ref), eq(projects.teamId, actor.teamId)));
  } else {
    const m = /^([A-Za-z]+)-(\d+)$/.exec(ref.trim());
    if (!m) throw new ServiceError("invalid", `Bad ticket ref "${ref}" (use uuid or KEY-123)`);
    [row] = await db
      .select({ t: tickets, p: projects })
      .from(tickets)
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .where(
        and(eq(projects.teamId, actor.teamId), eq(projects.key, m[1].toUpperCase()), eq(tickets.number, Number(m[2]))),
      );
  }
  if (!row) throw new ServiceError("not_found", `Ticket ${ref} not found`);
  return { ticket: row.t, project: row.p, ref: `${row.p.key}-${row.t.number}` };
}

export async function getTicket(actor: Actor, ref: string) {
  const db = await getDb();
  const { ticket, project, ref: r } = await resolveTicket(actor, ref);
  const [col] = await db.select().from(columns).where(eq(columns.id, ticket.columnId));
  const cs = await db.select().from(comments).where(eq(comments.ticketId, ticket.id)).orderBy(asc(comments.createdAt));
  const linked = await db
    .select({ id: nodes.id, name: nodes.name, kind: nodes.kind, parentId: nodes.parentId })
    .from(ticketNodes)
    .innerJoin(nodes, eq(nodes.id, ticketNodes.nodeId))
    .where(eq(ticketNodes.ticketId, ticket.id));
  const history = await db
    .select()
    .from(events)
    .where(and(eq(events.projectId, project.id), eq(events.entityId, ticket.id)))
    .orderBy(desc(events.seq))
    .limit(50);
  return { ticket: { ...ticket, ref: r, column: col?.name }, project, comments: cs, nodes: linked, history };
}

async function positionAt(q: Q, columnId: string, index: number | undefined, excludeId?: string) {
  const siblings = await q
    .select({ id: tickets.id, position: tickets.position })
    .from(tickets)
    .where(and(eq(tickets.columnId, columnId), excludeId ? ne(tickets.id, excludeId) : undefined))
    .orderBy(asc(tickets.position));
  const i = index === undefined || index < 0 || index > siblings.length ? siblings.length : index;
  const before = siblings[i - 1]?.position;
  const after = siblings[i]?.position;
  if (before === undefined && after === undefined) return 1000;
  if (before === undefined) return after! - 1000;
  if (after === undefined) return before + 1000;
  return (before + after) / 2;
}

export type TicketInput = {
  title?: string;
  body?: string;
  priority?: (typeof schema.PRIORITIES)[number];
  assigneeId?: string | null;
  agentClaimable?: boolean;
  labels?: string[];
};

export async function createTicket(actor: Actor, projectRef: string, input: TicketInput & { title: string; column?: string }) {
  const db = await getDb();
  const project = await getProject(actor, projectRef);
  if (!input.title?.trim()) throw new ServiceError("invalid", "title is required");
  return db.transaction(async (tx) => {
    const col = await resolveColumn(tx, project.id, input.column ?? DEFAULT_COLUMNS[0]);
    const [{ ticketCounter }] = await tx
      .update(projects)
      .set({ ticketCounter: sql`${projects.ticketCounter} + 1` })
      .where(eq(projects.id, project.id))
      .returning({ ticketCounter: projects.ticketCounter });
    const position = await positionAt(tx, col.id, undefined);
    const [t] = await tx
      .insert(tickets)
      .values({
        projectId: project.id,
        columnId: col.id,
        number: ticketCounter,
        title: input.title.trim(),
        body: input.body ?? "",
        priority: input.priority ?? "medium",
        assigneeId: input.assigneeId ?? null,
        agentClaimable: input.agentClaimable ?? actor.kind === "agent",
        labels: input.labels ?? [],
        position,
        createdByKind: actor.kind,
        createdById: actor.id,
      })
      .returning();
    const ref = `${project.key}-${t.number}`;
    await emit(tx, actor, project.id, {
      type: "ticket.created",
      entity: "ticket",
      entityId: t.id,
      summary: `created ${ref} "${t.title}" in ${col.name}`,
      data: { ref, column: col.name, title: t.title },
    });
    return { ...t, ref, column: col.name };
  });
}

/**
 * Patch a ticket. Pass `expectedVersion` for optimistic locking: if someone
 * (human or agent) changed the ticket since you read it, you get a 409 with
 * the current state instead of silently overwriting their change.
 */
export async function updateTicket(actor: Actor, ref: string, patch: TicketInput, expectedVersion?: number) {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const { ticket, project, ref: r } = await resolveTicket(actor, ref, tx);
    if (expectedVersion !== undefined && expectedVersion !== ticket.version) {
      throw new ServiceError("conflict", `${r} was changed (version ${ticket.version}, you had ${expectedVersion}). Re-read and retry.`, {
        current: ticket,
      });
    }
    const clean: TicketInput = {};
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (clean as Record<string, unknown>)[k] = v;
    const changes = diff(ticket as unknown as Record<string, unknown>, clean as Record<string, unknown>);
    if (!Object.keys(changes).length) return { ...ticket, ref: r };
    const [t] = await tx
      .update(tickets)
      .set({ ...clean, version: ticket.version + 1, updatedAt: new Date() })
      .where(eq(tickets.id, ticket.id))
      .returning();
    await emit(tx, actor, project.id, {
      type: "ticket.updated",
      entity: "ticket",
      entityId: t.id,
      summary: `updated ${r}: ${Object.keys(changes).join(", ")}`,
      data: { ref: r, changes },
    });
    return { ...t, ref: r };
  });
}

export async function moveTicket(actor: Actor, ref: string, column: string, index?: number, expectedVersion?: number) {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const { ticket, project, ref: r } = await resolveTicket(actor, ref, tx);
    if (expectedVersion !== undefined && expectedVersion !== ticket.version) {
      throw new ServiceError("conflict", `${r} was changed since you read it`, { current: ticket });
    }
    const to = await resolveColumn(tx, project.id, column);
    const [from] = await tx.select().from(columns).where(eq(columns.id, ticket.columnId));
    const position = await positionAt(tx, to.id, index, ticket.id);
    const [t] = await tx
      .update(tickets)
      .set({ columnId: to.id, position, version: ticket.version + 1, updatedAt: new Date() })
      .where(eq(tickets.id, ticket.id))
      .returning();
    if (from.id !== to.id) {
      await emit(tx, actor, project.id, {
        type: "ticket.moved",
        entity: "ticket",
        entityId: t.id,
        summary: `moved ${r} from ${from.name} → ${to.name}`,
        data: { ref: r, from: from.name, to: to.name },
      });
    }
    return { ...t, ref: r, column: to.name };
  });
}

export async function deleteTicket(actor: Actor, ref: string) {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const { ticket, project, ref: r } = await resolveTicket(actor, ref, tx);
    await tx.delete(tickets).where(eq(tickets.id, ticket.id));
    await emit(tx, actor, project.id, {
      type: "ticket.deleted",
      entity: "ticket",
      entityId: ticket.id,
      summary: `deleted ${r} "${ticket.title}"`,
      data: { ref: r, title: ticket.title },
    });
    return { ok: true };
  });
}

/** Agent claims a ticket it's about to work on (only if humans marked it claimable). */
export async function claimTicket(actor: Actor, ref: string) {
  if (actor.kind !== "agent") throw new ServiceError("forbidden", "Only agents claim tickets");
  const db = await getDb();
  return db.transaction(async (tx) => {
    const { ticket, project, ref: r } = await resolveTicket(actor, ref, tx);
    if (!ticket.agentClaimable) throw new ServiceError("forbidden", `${r} is not marked agent-claimable by the team`);
    if (ticket.claimedByKeyId && ticket.claimedByKeyId !== actor.id)
      throw new ServiceError("conflict", `${r} is already claimed by another agent`);
    const [t] = await tx
      .update(tickets)
      .set({ claimedByKeyId: actor.id, version: ticket.version + 1, updatedAt: new Date() })
      .where(eq(tickets.id, ticket.id))
      .returning();
    await emit(tx, actor, project.id, { type: "ticket.claimed", entity: "ticket", entityId: t.id, summary: `claimed ${r}`, data: { ref: r } });
    return { ...t, ref: r };
  });
}

export async function addComment(actor: Actor, ref: string, body: string) {
  if (!body?.trim()) throw new ServiceError("invalid", "Comment body is required");
  const db = await getDb();
  return db.transaction(async (tx) => {
    const { ticket, project, ref: r } = await resolveTicket(actor, ref, tx);
    const [c] = await tx
      .insert(comments)
      .values({ ticketId: ticket.id, authorKind: actor.kind, authorId: actor.id, authorName: actor.name, body: body.trim() })
      .returning();
    await emit(tx, actor, project.id, {
      type: "comment.created",
      entity: "ticket",
      entityId: ticket.id,
      summary: `commented on ${r}`,
      data: { ref: r, commentId: c.id, body: c.body },
    });
    return c;
  });
}

// ───────────────────────── graph ─────────────────────────

export async function getGraph(actor: Actor, projectRef: string) {
  const db = await getDb();
  const project = await getProject(actor, projectRef);
  const ns = await db.select().from(nodes).where(eq(nodes.projectId, project.id));
  const es = await db.select().from(edges).where(eq(edges.projectId, project.id));
  const nodeIds = ns.map((n) => n.id);
  const links = nodeIds.length
    ? await db
        .select({ nodeId: ticketNodes.nodeId, ticketId: tickets.id, number: tickets.number, title: tickets.title, columnId: tickets.columnId })
        .from(ticketNodes)
        .innerJoin(tickets, eq(tickets.id, ticketNodes.ticketId))
        .where(inArray(ticketNodes.nodeId, nodeIds))
    : [];
  return { project, nodes: ns, edges: es, ticketLinks: links.map((l) => ({ ...l, ref: `${project.key}-${l.number}` })) };
}

async function resolveNode(q: Q, projectId: string, ref: string) {
  const [n] = await q
    .select()
    .from(nodes)
    .where(and(eq(nodes.projectId, projectId), isUuid(ref) ? eq(nodes.id, ref) : eq(sql`lower(${nodes.name})`, ref.toLowerCase())));
  if (!n) throw new ServiceError("not_found", `Node "${ref}" not found`);
  return n;
}

export type NodeInput = {
  id?: string; // update when given (uuid or exact name)
  name?: string;
  kind?: (typeof schema.NODE_KINDS)[number];
  parent?: string | null; // parent node uuid or name; null = top level
  summary?: string;
  details?: string;
  status?: "planned" | "building" | "live" | "deprecated";
  x?: number;
  y?: number;
};

/** Create or update a graph node. Agents use names, the UI uses ids. */
export async function upsertNode(actor: Actor, projectRef: string, input: NodeInput) {
  const db = await getDb();
  const project = await getProject(actor, projectRef);
  return db.transaction(async (tx) => {
    let parentId: string | null | undefined = undefined;
    if (input.parent === null) parentId = null;
    else if (input.parent) parentId = (await resolveNode(tx, project.id, input.parent)).id;

    const existing = input.id
      ? await resolveNode(tx, project.id, input.id)
      : input.name
        ? (await tx
            .select()
            .from(nodes)
            .where(and(eq(nodes.projectId, project.id), eq(sql`lower(${nodes.name})`, input.name.toLowerCase()))))[0]
        : undefined;

    if (existing) {
      if (parentId === existing.id) throw new ServiceError("invalid", "A node cannot be its own parent");
      const reparented = parentId !== undefined && parentId !== existing.parentId;
      const patch = {
        name: input.name,
        kind: input.kind,
        parentId,
        summary: input.summary,
        details: input.details,
        status: input.status,
        // Positions are relative to the parent, so reset when the container changes.
        x: input.x ?? (reparented ? 20 : undefined),
        y: input.y ?? (reparented ? 60 : undefined),
        width: reparented ? null : undefined,
        height: reparented ? null : undefined,
      };
      const changes = diff(existing as unknown as Record<string, unknown>, patch as Record<string, unknown>);
      if (!Object.keys(changes).length) return existing;
      const [n] = await tx
        .update(nodes)
        .set({ ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), version: existing.version + 1, updatedAt: new Date() })
        .where(eq(nodes.id, existing.id))
        .returning();
      const meaningful = Object.keys(changes).filter((k) => k !== "x" && k !== "y");
      if (meaningful.length) {
        await emit(tx, actor, project.id, {
          type: "node.updated",
          entity: "node",
          entityId: n.id,
          summary: `updated ${n.kind} "${n.name}": ${meaningful.join(", ")}`,
          data: { name: n.name, changes: Object.fromEntries(meaningful.map((k) => [k, changes[k]])) },
        });
      }
      return n;
    }

    if (!input.name?.trim()) throw new ServiceError("invalid", "name is required to create a node");
    // Auto-place new nodes so agent-created graphs are readable without coordinates.
    let { x, y } = input;
    if (x === undefined || y === undefined) {
      const siblings = await tx
        .select({ id: nodes.id })
        .from(nodes)
        .where(and(eq(nodes.projectId, project.id), parentId ? eq(nodes.parentId, parentId) : sql`${nodes.parentId} is null`));
      const i = siblings.length;
      x = parentId ? 20 + (i % 2) * 200 : 50 + (i % 4) * 460;
      y = parentId ? 60 + Math.floor(i / 2) * 90 : 50 + Math.floor(i / 4) * 400;
    }
    const [n] = await tx
      .insert(nodes)
      .values({
        projectId: project.id,
        parentId: parentId ?? null,
        kind: input.kind ?? (parentId ? "module" : "service"),
        name: input.name.trim(),
        summary: input.summary ?? "",
        details: input.details ?? "",
        status: input.status ?? "planned",
        x,
        y,
      })
      .returning();
    await emit(tx, actor, project.id, {
      type: "node.created",
      entity: "node",
      entityId: n.id,
      summary: `added ${n.kind} "${n.name}"${parentId ? " (nested)" : ""}`,
      data: { name: n.name, kind: n.kind, parentId: n.parentId },
    });
    return n;
  });
}

/** Bulk position save from the canvas. Layout-only, not logged as events. */
export async function saveLayout(actor: Actor, projectRef: string, positions: { id: string; x: number; y: number; width?: number; height?: number }[]) {
  const db = await getDb();
  const project = await getProject(actor, projectRef);
  await db.transaction(async (tx) => {
    for (const p of positions) {
      await tx
        .update(nodes)
        .set({ x: p.x, y: p.y, ...(p.width ? { width: p.width, height: p.height } : {}) })
        .where(and(eq(nodes.id, p.id), eq(nodes.projectId, project.id)));
    }
  });
}

export async function deleteNode(actor: Actor, projectRef: string, ref: string) {
  const db = await getDb();
  const project = await getProject(actor, projectRef);
  return db.transaction(async (tx) => {
    const n = await resolveNode(tx, project.id, ref);
    // Remove the subtree (children reference parent_id without an FK).
    const all = await tx.select({ id: nodes.id, parentId: nodes.parentId }).from(nodes).where(eq(nodes.projectId, project.id));
    const doomed = new Set([n.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const x of all) if (x.parentId && doomed.has(x.parentId) && !doomed.has(x.id)) (doomed.add(x.id), (grew = true));
    }
    await tx.delete(nodes).where(inArray(nodes.id, [...doomed]));
    await emit(tx, actor, project.id, {
      type: "node.deleted",
      entity: "node",
      entityId: n.id,
      summary: `removed ${n.kind} "${n.name}"${doomed.size > 1 ? ` and ${doomed.size - 1} nested` : ""}`,
      data: { name: n.name },
    });
    return { ok: true };
  });
}

export async function upsertEdge(actor: Actor, projectRef: string, input: { from: string; to: string; label?: string }) {
  const db = await getDb();
  const project = await getProject(actor, projectRef);
  return db.transaction(async (tx) => {
    const from = await resolveNode(tx, project.id, input.from);
    const to = await resolveNode(tx, project.id, input.to);
    const [existing] = await tx
      .select()
      .from(edges)
      .where(and(eq(edges.fromNodeId, from.id), eq(edges.toNodeId, to.id)));
    if (existing) {
      if (input.label === undefined || input.label === existing.label) return existing;
      const [e] = await tx.update(edges).set({ label: input.label }).where(eq(edges.id, existing.id)).returning();
      return e;
    }
    const [e] = await tx
      .insert(edges)
      .values({ projectId: project.id, fromNodeId: from.id, toNodeId: to.id, label: input.label ?? "" })
      .returning();
    await emit(tx, actor, project.id, {
      type: "edge.created",
      entity: "edge",
      entityId: e.id,
      summary: `connected "${from.name}" → "${to.name}"${e.label ? ` (${e.label})` : ""}`,
    });
    return e;
  });
}

export async function deleteEdge(actor: Actor, projectRef: string, edgeId: string) {
  const db = await getDb();
  const project = await getProject(actor, projectRef);
  await db.delete(edges).where(and(eq(edges.id, edgeId), eq(edges.projectId, project.id)));
  return { ok: true };
}

export async function linkTicketNode(actor: Actor, ticketRef: string, nodeRef: string, unlink = false) {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const { ticket, project, ref } = await resolveTicket(actor, ticketRef, tx);
    const n = await resolveNode(tx, project.id, nodeRef);
    if (unlink) {
      await tx.delete(ticketNodes).where(and(eq(ticketNodes.ticketId, ticket.id), eq(ticketNodes.nodeId, n.id)));
    } else {
      await tx.insert(ticketNodes).values({ ticketId: ticket.id, nodeId: n.id }).onConflictDoNothing();
    }
    await emit(tx, actor, project.id, {
      type: unlink ? "ticket.unlinked" : "ticket.linked",
      entity: "ticket",
      entityId: ticket.id,
      summary: `${unlink ? "unlinked" : "linked"} ${ref} ${unlink ? "from" : "to"} "${n.name}"`,
      data: { ref, node: n.name },
    });
    return { ok: true };
  });
}

// ───────────────────────── events / AI queue ─────────────────────────

export async function listEvents(actor: Actor, projectRef: string, opts: { afterSeq?: number; limit?: number; actorKind?: "human" | "agent" } = {}) {
  const db = await getDb();
  const project = await getProject(actor, projectRef);
  return db
    .select()
    .from(events)
    .where(
      and(
        eq(events.projectId, project.id),
        opts.afterSeq ? gt(events.seq, opts.afterSeq) : undefined,
        opts.actorKind ? eq(events.actorKind, opts.actorKind) : undefined,
      ),
    )
    .orderBy(opts.afterSeq ? asc(events.seq) : desc(events.seq))
    .limit(Math.min(opts.limit ?? 100, 500));
}

/**
 * The AI queue: changes since this agent's cursor, excluding the agent's own
 * writes. Humans rearranging the board, editing tickets, or commenting show up
 * here. Call `ackChanges` with the last seq you processed.
 */
export async function getChanges(actor: Actor, projectRef: string, limit = 100) {
  if (actor.kind !== "agent") throw new ServiceError("forbidden", "The change queue is per agent API key");
  const db = await getDb();
  const project = await getProject(actor, projectRef);
  const [cur] = await db
    .select()
    .from(agentCursors)
    .where(and(eq(agentCursors.apiKeyId, actor.id), eq(agentCursors.projectId, project.id)));
  const after = cur?.lastSeq ?? 0;
  const rows = await db
    .select()
    .from(events)
    .where(
      and(
        eq(events.projectId, project.id),
        gt(events.seq, after),
        or(ne(events.actorKind, "agent"), ne(events.actorId, actor.id)),
      ),
    )
    .orderBy(asc(events.seq))
    .limit(Math.min(limit, 500));
  return { cursor: after, changes: rows, hasMore: rows.length === Math.min(limit, 500) };
}

export async function ackChanges(actor: Actor, projectRef: string, seq: number) {
  if (actor.kind !== "agent") throw new ServiceError("forbidden", "The change queue is per agent API key");
  const db = await getDb();
  const project = await getProject(actor, projectRef);
  await db
    .insert(agentCursors)
    .values({ apiKeyId: actor.id, projectId: project.id, lastSeq: seq })
    .onConflictDoUpdate({
      target: [agentCursors.apiKeyId, agentCursors.projectId],
      set: { lastSeq: sql`greatest(${agentCursors.lastSeq}, ${seq})` },
    });
  return { ok: true, cursor: seq };
}

/** Pending queue depth per agent key, shown in the UI so humans know what the AI hasn't seen yet. */
export async function queueStatus(actor: Actor, projectRef: string) {
  const db = await getDb();
  const project = await getProject(actor, projectRef);
  const keys = await db
    .select({ id: schema.apiKeys.id, name: schema.apiKeys.name, lastUsedAt: schema.apiKeys.lastUsedAt })
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.teamId, actor.teamId), sql`${schema.apiKeys.revokedAt} is null`));
  const out = [];
  for (const k of keys) {
    const [cur] = await db
      .select()
      .from(agentCursors)
      .where(and(eq(agentCursors.apiKeyId, k.id), eq(agentCursors.projectId, project.id)));
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(events)
      .where(
        and(
          eq(events.projectId, project.id),
          gt(events.seq, cur?.lastSeq ?? 0),
          or(ne(events.actorKind, "agent"), ne(events.actorId, k.id)),
        ),
      );
    out.push({ ...k, pending: Number(n) });
  }
  return out;
}
