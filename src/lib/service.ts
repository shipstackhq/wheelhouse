import "server-only";
import { and, asc, desc, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import { getDb, schema, type DB } from "@/db";
import type { Actor } from "./auth";

/**
 * The single write path for Wheelhouse. UI server actions, the REST API and the
 * MCP server all call into here, so every mutation is team-scoped, versioned
 * where it matters, and recorded in `events` (the activity feed + AI queue).
 */

const { projects, columns, tickets, comments, nodes, edges, ticketNodes, events, agentCursors, flows, decisions, terms } = schema;

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

export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
export type Q = DB | Tx;

export async function emit(
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

const CLAIM_TTL_MS = 24 * 3600e3;

/**
 * Release agent claims with no activity from the claiming agent for a day, so a
 * crashed or abandoned session doesn't hold work hostage. Logged as an event.
 */
export async function expireStaleClaims(projectId: string) {
  const db = await getDb();
  const claimed = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.projectId, projectId), sql`${tickets.claimedByKeyId} is not null`));
  for (const t of claimed) {
    const [last] = await db
      .select({ at: events.createdAt })
      .from(events)
      .where(and(eq(events.entityId, t.id), eq(events.actorId, t.claimedByKeyId!)))
      .orderBy(desc(events.seq))
      .limit(1);
    const lastAt = new Date(last?.at ?? t.updatedAt).getTime();
    if (Date.now() - lastAt < CLAIM_TTL_MS) continue;
    const [p] = await db.select().from(projects).where(eq(projects.id, projectId));
    await db.transaction(async (tx) => {
      await tx.update(tickets).set({ claimedByKeyId: null, version: t.version + 1, updatedAt: new Date() }).where(eq(tickets.id, t.id));
      await tx.insert(events).values({
        teamId: p.teamId,
        projectId,
        actorKind: "human",
        actorId: null,
        actorName: "Wheelhouse",
        type: "ticket.claim_expired",
        entity: "ticket",
        entityId: t.id,
        summary: `released ${p.key}-${t.number}: no activity from the claiming agent for 24h`,
        data: { ref: `${p.key}-${t.number}` },
      });
    });
  }
}

export async function getBoard(actor: Actor, projectRef: string) {
  const db = await getDb();
  const project = await getProject(actor, projectRef);
  await expireStaleClaims(project.id);
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
  return bindSession(actor, await updateTicketTx(actor, ref, patch, expectedVersion));
}

async function updateTicketTx(actor: Actor, ref: string, patch: TicketInput, expectedVersion?: number) {
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
  return bindSession(actor, await moveTicketTx(actor, ref, column, index, expectedVersion));
}

async function moveTicketTx(actor: Actor, ref: string, column: string, index?: number, expectedVersion?: number) {
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
  const t = await db.transaction(async (tx) => {
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
  return bindSession(actor, t);
}

/** An agent working a ticket binds it to its active session (for the reconciliation check). */
async function bindSession<T extends { id: string; projectId: string }>(actor: Actor, t: T): Promise<T> {
  if (actor.kind === "agent") {
    const { noteTicketActivity } = await import("./sync");
    await noteTicketActivity(actor, t.projectId, t.id);
  }
  return t;
}

export async function addComment(actor: Actor, ref: string, body: string) {
  if (!body?.trim()) throw new ServiceError("invalid", "Comment body is required");
  const db = await getDb();
  const { c, ticket } = await db.transaction(async (tx) => {
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
    return { c, ticket };
  });
  await bindSession(actor, ticket);
  return c;
}

// ───────────────────────── knowledge map ─────────────────────────
//
// One linked model at three zoom levels (concept → system → code). `depends`
// edges connect nodes within a level; `implements` edges connect a lower level
// to the higher-level thing it realizes. Flows, decisions and the glossary hang
// off nodes. Anchors + reported file changes keep the explanations honest.

export type NodeRow = typeof nodes.$inferSelect;
type Layer = schema.Layer;

const LAYER_RANK: Record<Layer, number> = { concept: 0, system: 1, data: 2, code: 3 };

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
  const fl = await db.select().from(flows).where(eq(flows.projectId, project.id)).orderBy(asc(flows.name));
  const ds = await db.select().from(decisions).where(eq(decisions.projectId, project.id)).orderBy(asc(decisions.number));
  const ts = await db.select().from(terms).where(eq(terms.projectId, project.id)).orderBy(asc(terms.term));
  const alive = new Set(nodeIds);
  return {
    project,
    nodes: ns,
    edges: es,
    ticketLinks: links.map((l) => ({ ...l, ref: `${project.key}-${l.number}` })),
    flows: fl.map((f) => ({ ...f, steps: f.steps.filter((s) => alive.has(s.nodeId)) })),
    decisions: ds.map((d) => ({ ...d, nodeIds: d.nodeIds.filter((id) => alive.has(id)) })),
    terms: ts,
    // Nodes whose files are being changed in active sessions, and pending drafts.
    flux: await (await import("./sync")).fluxForProject(project.id),
  };
}

/**
 * Resolve a node by uuid or name (case-insensitive). Names may repeat across
 * layers ("Billing" concept vs "billing" service), so pass `layer` or use the
 * "layer:name" form to disambiguate.
 */
export async function resolveNode(q: Q, projectId: string, ref: string, layer?: Layer) {
  let name = ref.trim();
  const m = /^(concept|system|data|code):(.+)$/i.exec(name);
  if (m) {
    layer = m[1].toLowerCase() as Layer;
    name = m[2].trim();
  }
  const rows = await q
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.projectId, projectId),
        isUuid(name) ? eq(nodes.id, name) : eq(sql`lower(${nodes.name})`, name.toLowerCase()),
        layer && !isUuid(name) ? eq(nodes.layer, layer) : undefined,
      ),
    );
  if (!rows.length) throw new ServiceError("not_found", `Node "${ref}" not found`);
  if (rows.length > 1)
    throw new ServiceError(
      "invalid",
      `"${ref}" is ambiguous (${rows.map((r) => `${r.layer}:${r.name}`).join(", ")}). Prefix with the layer, e.g. "${rows[0].layer}:${rows[0].name}".`,
    );
  return rows[0];
}

/** Everything about one node: explainer, neighbours on every layer, flows, decisions, tickets. */
export async function getNode(actor: Actor, projectRef: string, ref: string) {
  const g = await getGraph(actor, projectRef);
  const db = await getDb();
  const n = await resolveNode(db, g.project.id, ref);
  const byId = new Map(g.nodes.map((x) => [x.id, x]));
  const brief = (x: NodeRow | undefined) => x && { id: x.id, name: x.name, layer: x.layer, kind: x.kind, summary: x.summary, stale: x.stale };
  const out = g.edges.filter((e) => e.fromNodeId === n.id);
  const inc = g.edges.filter((e) => e.toNodeId === n.id);
  return {
    node: n,
    parent: brief(n.parentId ? byId.get(n.parentId) : undefined) ?? null,
    children: g.nodes.filter((c) => c.parentId === n.id).map(brief),
    dependsOn: out.filter((e) => e.kind === "depends").map((e) => ({ ...brief(byId.get(e.toNodeId)), label: e.label })),
    usedBy: inc.filter((e) => e.kind === "depends").map((e) => ({ ...brief(byId.get(e.fromNodeId)), label: e.label })),
    implements: out.filter((e) => e.kind === "implements").map((e) => brief(byId.get(e.toNodeId))),
    implementedBy: inc.filter((e) => e.kind === "implements").map((e) => brief(byId.get(e.fromNodeId))),
    flows: g.flows
      .filter((f) => f.steps.some((s) => s.nodeId === n.id))
      .map((f) => ({ id: f.id, name: f.name, step: f.steps.findIndex((s) => s.nodeId === n.id) + 1 })),
    decisions: g.decisions
      .filter((d) => d.nodeIds.includes(n.id))
      .map((d) => ({ number: d.number, title: d.title, status: d.status })),
    tickets: g.ticketLinks.filter((l) => l.nodeId === n.id).map((l) => ({ ref: l.ref, title: l.title })),
  };
}

export type NodeInput = {
  id?: string; // update when given (uuid or name)
  name?: string;
  layer?: Layer;
  kind?: (typeof schema.NODE_KINDS)[number];
  parent?: string | null; // parent node uuid or name (same layer); null = top level
  summary?: string;
  purpose?: string;
  responsibilities?: string;
  interfaces?: string;
  gotchas?: string;
  details?: string;
  status?: "planned" | "building" | "live" | "deprecated";
  anchors?: string[];
  describedSha?: string;
  markFresh?: boolean;
  implements?: string[]; // higher-layer nodes this one realizes
  columns?: schema.Column[]; // data layer only
  indexes?: schema.Index[]; // data layer only
  forcePublish?: boolean; // skip the in-flux draft check (landing, human publish)
  describedHashes?: Record<string, string>; // content hashes the explanation was written against
  x?: number;
  y?: number;
};

const EXPLAINER_FIELDS = ["summary", "purpose", "responsibilities", "interfaces", "gotchas", "details"] as const;

function defaultKind(layer: Layer, hasParent: boolean): (typeof schema.NODE_KINDS)[number] {
  if (layer === "concept") return hasParent ? "capability" : "concept";
  if (layer === "code") return hasParent ? "file" : "directory";
  if (layer === "data") return "table";
  return hasParent ? "module" : "service";
}

function checkKind(layer: Layer, kind: string) {
  const allowed = schema.KINDS_BY_LAYER[layer] as readonly string[];
  if (!allowed.includes(kind))
    throw new ServiceError("invalid", `kind "${kind}" isn't valid on the ${layer} layer (use: ${allowed.join(", ")})`);
}

/** Create or update a map node. Agents use names, the UI uses ids. */
export async function upsertNode(actor: Actor, projectRef: string, input: NodeInput) {
  const db = await getDb();
  const project = await getProject(actor, projectRef);

  // An agent describing code its own session hasn't landed yet: store a draft
  // instead of rewriting the shared map (published when the code lands).
  if (actor.kind === "agent" && !input.forcePublish && (input.id || input.name)) {
    const ref = input.id ?? input.name!;
    const found = await resolveNode(db, project.id, ref, input.layer).catch(() => undefined);
    if (found) {
      const { maybeDraft } = await import("./sync");
      const d = await maybeDraft(actor, found, input);
      if (d) return { ...found, ...d };
    }
  }

  const result = await db.transaction(async (tx) => {
    let existing: NodeRow | undefined;
    if (input.id) existing = await resolveNode(tx, project.id, input.id, input.layer);
    else if (input.name) {
      const rows = await tx
        .select()
        .from(nodes)
        .where(
          and(
            eq(nodes.projectId, project.id),
            eq(sql`lower(${nodes.name})`, input.name.trim().toLowerCase()),
            input.layer ? eq(nodes.layer, input.layer) : undefined,
          ),
        );
      if (rows.length > 1) throw new ServiceError("invalid", `"${input.name}" exists on several layers; pass layer`);
      existing = rows[0];
    }

    const layer: Layer = existing?.layer ?? input.layer ?? "system";
    if (existing && input.layer && input.layer !== existing.layer)
      throw new ServiceError("invalid", `Can't move "${existing.name}" between layers; create a new node and link it with implements`);

    let parentId: string | null | undefined = undefined;
    if (input.parent === null) parentId = null;
    else if (input.parent) {
      const p = await resolveNode(tx, project.id, input.parent, layer);
      if (p.layer !== layer) throw new ServiceError("invalid", `Parent must be on the same layer (${layer})`);
      parentId = p.id;
    }
    if (input.kind) checkKind(layer, input.kind);
    if ((input.columns || input.indexes) && layer !== "data")
      throw new ServiceError("invalid", "columns/indexes only apply to data-layer nodes (tables, views, enums)");
    const columns = input.columns?.map(cleanColumn);

    if (existing) {
      if (parentId === existing.id) throw new ServiceError("invalid", "A node cannot be its own parent");
      const reparented = parentId !== undefined && parentId !== existing.parentId;
      const patch = {
        name: input.name?.trim(),
        kind: input.kind,
        parentId,
        summary: input.summary,
        purpose: input.purpose,
        responsibilities: input.responsibilities,
        interfaces: input.interfaces,
        gotchas: input.gotchas,
        details: input.details,
        status: input.status,
        anchors: input.anchors,
        columns,
        indexes: input.indexes,
        // Positions are relative to the parent, so reset when the container changes.
        x: input.x ?? (reparented ? 20 : undefined),
        y: input.y ?? (reparented ? 60 : undefined),
        width: reparented ? null : undefined,
        height: reparented ? null : undefined,
      };
      const changes = diff(existing as unknown as Record<string, unknown>, patch as Record<string, unknown>);
      const described =
        EXPLAINER_FIELDS.some((f) => f in changes) || "anchors" in changes || "columns" in changes || "indexes" in changes || input.markFresh || input.describedSha;
      const fresh = described
        ? {
            stale: false,
            staleReason: null,
            staleSource: null,
            driftPaths: [],
            describedHashes: input.describedHashes ?? (await landedHashesFor(tx, project.id, input.anchors ?? existing.anchors)),
            describedAt: new Date(),
            describedSha: input.describedSha ?? existing.describedSha,
          }
        : {};
      if (!Object.keys(changes).length && !described) return { node: existing, created: false };
      const [n] = await tx
        .update(nodes)
        .set({
          ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
          ...fresh,
          version: existing.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(nodes.id, existing.id))
        .returning();
      const meaningful = Object.keys(changes).filter((k) => !["x", "y", "width", "height"].includes(k));
      if (meaningful.length || (existing.stale && described)) {
        await emit(tx, actor, project.id, {
          type: "node.updated",
          entity: "node",
          entityId: n.id,
          summary: `updated ${n.layer} ${n.kind} "${n.name}"${meaningful.length ? `: ${meaningful.join(", ")}` : ""}${existing.stale && described ? " (now fresh)" : ""}`,
          data: { name: n.name, layer: n.layer, fields: meaningful },
        });
      }
      return { node: n, created: false, schemaChanged: "columns" in changes || "name" in changes };
    }

    if (!input.name?.trim()) throw new ServiceError("invalid", "name is required to create a node");
    // Auto-place new nodes so agent-created maps are readable without coordinates.
    let { x, y } = input;
    if (x === undefined || y === undefined) {
      const siblings = await tx
        .select({ id: nodes.id })
        .from(nodes)
        .where(
          and(
            eq(nodes.projectId, project.id),
            eq(nodes.layer, layer),
            parentId ? eq(nodes.parentId, parentId) : sql`${nodes.parentId} is null`,
          ),
        );
      const i = siblings.length;
      if (layer === "data" && !parentId) {
        // ERD cards vary in height: stack into 4 columns by accumulated height.
        const placed = await tx
          .select({ x: nodes.x, y: nodes.y, columns: nodes.columns })
          .from(nodes)
          .where(and(eq(nodes.projectId, project.id), eq(nodes.layer, "data")));
        const col = i % 4;
        const inCol = placed.filter((p) => Math.round((p.x - 50) / 320) === col);
        x = 50 + col * 320;
        y = inCol.reduce((m, p) => Math.max(m, p.y + tableHeight(p.columns.length) + 40), 50);
      } else {
        x = parentId ? 20 + (i % 2) * 210 : 50 + (i % 4) * 480;
        y = parentId ? 70 + Math.floor(i / 2) * 100 : 50 + Math.floor(i / 4) * 420;
      }
    }
    const kind = input.kind ?? defaultKind(layer, !!parentId);
    const [n] = await tx
      .insert(nodes)
      .values({
        projectId: project.id,
        parentId: parentId ?? null,
        layer,
        kind,
        name: input.name.trim(),
        summary: input.summary ?? "",
        purpose: input.purpose ?? "",
        responsibilities: input.responsibilities ?? "",
        interfaces: input.interfaces ?? "",
        gotchas: input.gotchas ?? "",
        details: input.details ?? "",
        status: input.status ?? "planned",
        anchors: input.anchors ?? [],
        columns: columns ?? [],
        indexes: input.indexes ?? [],
        describedHashes: input.describedHashes ?? (await landedHashesFor(tx, project.id, input.anchors ?? [])),
        describedSha: input.describedSha ?? null,
        describedAt: new Date(),
        x,
        y,
      })
      .returning();
    await emit(tx, actor, project.id, {
      type: "node.created",
      entity: "node",
      entityId: n.id,
      summary: `added ${n.layer} ${n.kind} "${n.name}"${parentId ? " (nested)" : ""}`,
      data: { name: n.name, layer: n.layer, kind: n.kind, parentId: n.parentId },
    });
    return { node: n, created: true, schemaChanged: n.layer === "data" };
  });

  for (const target of input.implements ?? []) {
    await upsertEdge(actor, project.id, { from: result.node.id, to: target, kind: "implements" });
  }
  if (result.schemaChanged) await syncReferences(actor, project.id);
  return result.node;
}

/** Landed content hashes for files matching these anchors: the baseline an explanation is written against. */
async function landedHashesFor(q: Q, projectId: string, anchors: string[]) {
  if (!anchors.length) return {};
  const files = await q.select({ path: schema.projectFiles.path, hash: schema.projectFiles.hash }).from(schema.projectFiles).where(eq(schema.projectFiles.projectId, projectId));
  return Object.fromEntries(files.filter((f) => anchors.some((a) => anchorScore(a, f.path) > 0)).map((f) => [f.path, f.hash]));
}

// ───────── data layer ─────────

/** Rendered height of an ERD card, shared with the canvas so auto-placement doesn't overlap. */
export const tableHeight = (columns: number) => 48 + Math.max(1, columns) * 22;

function cleanColumn(c: schema.Column): schema.Column {
  if (!c.name?.trim()) throw new ServiceError("invalid", "Every column needs a name");
  const out: schema.Column = { name: c.name.trim(), type: (c.type ?? "").trim() };
  if (c.nullable) out.nullable = true;
  if (c.pk) out.pk = true;
  if (c.unique) out.unique = true;
  if (c.default) out.default = c.default;
  if (c.references?.trim()) {
    if (!/^[^.\s]+\.[^.\s]+$/.test(c.references.trim()))
      throw new ServiceError("invalid", `Column "${c.name}": references must look like "table.column"`);
    out.references = c.references.trim();
  }
  if (c.onDelete) out.onDelete = c.onDelete;
  if (c.note) out.note = c.note;
  return out;
}

/**
 * Derive "references" edges from columns' `references: "table.column"`.
 * Columns are the single source of truth: edges are added, updated and removed
 * to match. Returns FK targets that don't exist on the map yet.
 */
export async function syncReferences(actor: Actor, projectRef: string) {
  const db = await getDb();
  const project = await getProject(actor, projectRef);
  const tables = await db.select().from(nodes).where(and(eq(nodes.projectId, project.id), eq(nodes.layer, "data")));
  const byName = new Map(tables.map((t) => [t.name.toLowerCase(), t]));
  const current = (await db.select().from(edges).where(and(eq(edges.projectId, project.id), eq(edges.kind, "references")))).filter(
    (e) => e.meta?.derived,
  );
  const key = (from: string, col: string) => `${from}:${col.toLowerCase()}`;
  const want = new Map<string, { from: NodeRow; to: NodeRow; meta: schema.EdgeMeta }>();
  const unresolved: string[] = [];
  for (const t of tables) {
    for (const c of t.columns) {
      if (!c.references) continue;
      const [tn, cn] = c.references.split(".");
      const target = byName.get(tn.toLowerCase());
      if (!target) {
        unresolved.push(`${t.name}.${c.name} → ${c.references}`);
        continue;
      }
      want.set(key(t.id, c.name), {
        from: t,
        to: target,
        meta: {
          derived: true,
          fromColumn: c.name,
          toColumn: cn,
          // One-to-one only when the FK column alone is unique: a sole PK or a unique column.
          // Part of a composite PK (e.g. a join table) is still many-to-one.
          cardinality: c.unique || (c.pk && t.columns.filter((x) => x.pk).length === 1) ? "1-1" : "n-1",
          ...(c.onDelete ? { onDelete: c.onDelete } : {}),
        },
      });
    }
  }
  let changed = 0;
  await db.transaction(async (tx) => {
    for (const e of current) {
      const w = want.get(key(e.fromNodeId, e.meta.fromColumn ?? ""));
      if (!w || w.to.id !== e.toNodeId) {
        await tx.delete(edges).where(eq(edges.id, e.id));
        changed++;
        continue;
      }
      if (JSON.stringify(w.meta) !== JSON.stringify(e.meta)) {
        await tx.update(edges).set({ meta: w.meta, label: `${w.meta.fromColumn} → ${w.meta.toColumn}` }).where(eq(edges.id, e.id));
        changed++;
      }
      want.delete(key(e.fromNodeId, e.meta.fromColumn ?? ""));
    }
    for (const w of want.values()) {
      await tx.insert(edges).values({
        projectId: project.id,
        fromNodeId: w.from.id,
        toNodeId: w.to.id,
        kind: "references",
        label: `${w.meta.fromColumn} → ${w.meta.toColumn}`,
        meta: w.meta,
      });
      changed++;
    }
    if (changed) {
      await emit(tx, actor, project.id, {
        type: "schema.relationships",
        entity: "project",
        entityId: project.id,
        summary: `updated ${changed} table relationship${changed === 1 ? "" : "s"}`,
        data: { changed },
      });
    }
  });
  return { changed, unresolved };
}

/** Compact data-layer view for agents: tables, columns, relationships. */
export async function getSchema(actor: Actor, projectRef: string) {
  const g = await getGraph(actor, projectRef);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const tables = g.nodes.filter((n) => n.layer === "data").sort((a, b) => a.name.localeCompare(b.name));
  return {
    tables: tables.map((t) => ({
      name: t.name,
      kind: t.kind,
      summary: t.summary || undefined,
      columns: t.columns,
      indexes: t.indexes.length ? t.indexes : undefined,
      anchors: t.anchors.length ? t.anchors : undefined,
      stale: t.stale || undefined,
      implements: g.edges
        .filter((e) => e.kind === "implements" && e.fromNodeId === t.id)
        .map((e) => `${byId.get(e.toNodeId)?.layer}:${byId.get(e.toNodeId)?.name}`),
    })),
    relationships: g.edges
      .filter((e) => e.kind === "references")
      .map((e) => ({
        from: `${byId.get(e.fromNodeId)?.name}${e.meta.fromColumn ? "." + e.meta.fromColumn : ""}`,
        to: `${byId.get(e.toNodeId)?.name}${e.meta.toColumn ? "." + e.meta.toColumn : ""}`,
        cardinality: e.meta.cardinality,
        onDelete: e.meta.onDelete,
      })),
  };
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
      for (const x of all) if (x.parentId && doomed.has(x.parentId) && !doomed.has(x.id)) {
        doomed.add(x.id);
        grew = true;
      }
    }
    await tx.delete(nodes).where(inArray(nodes.id, [...doomed]));
    await emit(tx, actor, project.id, {
      type: "node.deleted",
      entity: "node",
      entityId: n.id,
      summary: `removed ${n.layer} ${n.kind} "${n.name}"${doomed.size > 1 ? ` and ${doomed.size - 1} nested` : ""}`,
      data: { name: n.name, layer: n.layer },
    });
    return { ok: true };
  });
}

/**
 * Connect two nodes. `depends`: from uses/calls to. `implements`: from (a lower
 * layer, e.g. code) realizes to (a higher layer, e.g. a system or concept).
 */
export async function upsertEdge(
  actor: Actor,
  projectRef: string,
  input: { from: string; to: string; label?: string; kind?: (typeof schema.EDGE_KINDS)[number] },
) {
  const db = await getDb();
  const project = await getProject(actor, projectRef);
  const kind = input.kind ?? "depends";
  return db.transaction(async (tx) => {
    const from = await resolveNode(tx, project.id, input.from);
    const to = await resolveNode(tx, project.id, input.to);
    if (from.id === to.id) throw new ServiceError("invalid", "Can't connect a node to itself");
    if (kind === "implements" && LAYER_RANK[from.layer] <= LAYER_RANK[to.layer])
      throw new ServiceError(
        "invalid",
        `implements goes from a lower layer to a higher one (code → data → system → concept); "${from.name}" is ${from.layer}, "${to.name}" is ${to.layer}`,
      );
    if (kind === "references" && (from.layer !== "data" || to.layer !== "data"))
      throw new ServiceError("invalid", "references connects two data-layer tables (set column.references instead to get column-level links)");
    const [existing] = await tx
      .select()
      .from(edges)
      .where(and(eq(edges.fromNodeId, from.id), eq(edges.toNodeId, to.id), eq(edges.kind, kind)));
    if (existing) {
      if (input.label === undefined || input.label === existing.label) return existing;
      const [e] = await tx.update(edges).set({ label: input.label }).where(eq(edges.id, existing.id)).returning();
      return e;
    }
    const [e] = await tx
      .insert(edges)
      .values({ projectId: project.id, fromNodeId: from.id, toNodeId: to.id, kind, label: input.label ?? "" })
      .returning();
    await emit(tx, actor, project.id, {
      type: "edge.created",
      entity: "edge",
      entityId: e.id,
      summary:
        kind === "implements"
          ? `linked ${from.layer} "${from.name}" implements ${to.layer} "${to.name}"`
          : `connected "${from.name}" → "${to.name}"${e.label ? ` (${e.label})` : ""}`,
      data: { kind, from: from.name, to: to.name },
    });
    return e;
  });
}

export async function deleteEdge(actor: Actor, projectRef: string, edgeId: string) {
  const db = await getDb();
  const project = await getProject(actor, projectRef);
  return db.transaction(async (tx) => {
    const [e] = await tx.delete(edges).where(and(eq(edges.id, edgeId), eq(edges.projectId, project.id))).returning();
    if (!e) return { ok: true };
    const names = await tx.select({ id: nodes.id, name: nodes.name }).from(nodes).where(inArray(nodes.id, [e.fromNodeId, e.toNodeId]));
    const name = (id: string) => names.find((n) => n.id === id)?.name ?? "?";
    await emit(tx, actor, project.id, {
      type: "edge.deleted",
      entity: "edge",
      entityId: e.id,
      summary: `removed ${e.kind === "implements" ? "implements link" : "connection"} "${name(e.fromNodeId)}" → "${name(e.toNodeId)}"`,
      data: { kind: e.kind, from: name(e.fromNodeId), to: name(e.toNodeId) },
    });
    return { ok: true };
  });
}

/** Remove a link by endpoints (agent-friendly). */
export async function unlinkNodes(actor: Actor, projectRef: string, input: { from: string; to: string; kind?: (typeof schema.EDGE_KINDS)[number] }) {
  const db = await getDb();
  const project = await getProject(actor, projectRef);
  const from = await resolveNode(db, project.id, input.from);
  const to = await resolveNode(db, project.id, input.to);
  const found = await db
    .select({ id: edges.id })
    .from(edges)
    .where(and(eq(edges.fromNodeId, from.id), eq(edges.toNodeId, to.id), input.kind ? eq(edges.kind, input.kind) : undefined));
  for (const e of found) await deleteEdge(actor, project.id, e.id); // logged like UI deletes
  return { ok: true, removed: found.length };
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

// ───────── flows ─────────

export type FlowInput = {
  id?: string;
  name: string;
  description?: string;
  steps?: { node: string; title: string; detail?: string }[];
};

/** Create or replace a flow (matched by id, else by name). Steps are replaced wholesale. */
export async function upsertFlow(actor: Actor, projectRef: string, input: FlowInput) {
  const db = await getDb();
  const project = await getProject(actor, projectRef);
  if (!input.name?.trim()) throw new ServiceError("invalid", "Flow name is required");
  return db.transaction(async (tx) => {
    const steps: schema.FlowStep[] | undefined = input.steps
      ? await Promise.all(
          input.steps.map(async (s) => ({
            nodeId: (await resolveNode(tx, project.id, s.node)).id,
            title: s.title.trim(),
            detail: s.detail ?? "",
          })),
        )
      : undefined;
    const [existing] = await tx
      .select()
      .from(flows)
      .where(
        and(
          eq(flows.projectId, project.id),
          input.id && isUuid(input.id) ? eq(flows.id, input.id) : eq(sql`lower(${flows.name})`, (input.id ?? input.name).trim().toLowerCase()),
        ),
      );
    if (existing) {
      const [f] = await tx
        .update(flows)
        .set({
          name: input.name.trim(),
          description: input.description ?? existing.description,
          steps: steps ?? existing.steps,
          version: existing.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(flows.id, existing.id))
        .returning();
      await emit(tx, actor, project.id, { type: "flow.updated", entity: "flow", entityId: f.id, summary: `updated flow "${f.name}" (${f.steps.length} steps)`, data: { name: f.name } });
      return f;
    }
    const [f] = await tx
      .insert(flows)
      .values({ projectId: project.id, name: input.name.trim(), description: input.description ?? "", steps: steps ?? [] })
      .returning();
    await emit(tx, actor, project.id, { type: "flow.created", entity: "flow", entityId: f.id, summary: `added flow "${f.name}" (${f.steps.length} steps)`, data: { name: f.name } });
    return f;
  });
}

export async function deleteFlow(actor: Actor, projectRef: string, ref: string) {
  const db = await getDb();
  const project = await getProject(actor, projectRef);
  const [f] = await db
    .select()
    .from(flows)
    .where(and(eq(flows.projectId, project.id), isUuid(ref) ? eq(flows.id, ref) : eq(sql`lower(${flows.name})`, ref.toLowerCase())));
  if (!f) throw new ServiceError("not_found", `Flow "${ref}" not found`);
  await db.delete(flows).where(eq(flows.id, f.id));
  await emit(db, actor, project.id, { type: "flow.deleted", entity: "flow", entityId: f.id, summary: `removed flow "${f.name}"` });
  return { ok: true };
}

// ───────── freshness ─────────

export const normPath = (p: string) => p.trim().replace(/^\.\//, "").replace(/\\/g, "/");

/** How specifically `anchor` matches `file` (0 = no match). Longer literal prefix = more specific. */
export function anchorScore(anchor: string, file: string) {
  const a = normPath(anchor).split("#")[0];
  const f = normPath(file);
  if (!a) return 0;
  if (/[*?]/.test(a)) {
    const re = new RegExp(
      "^" +
        a
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*\/?/g, "\u0000")
          .replace(/\*/g, "[^/]*")
          .replace(/\?/g, "[^/]")
          .replace(/\u0000/g, ".*") +
        "$",
    );
    return re.test(f) ? a.replace(/[*?].*$/, "").length + 1 : 0;
  }
  if (f === a) return a.length + 1000; // exact file beats any directory/glob
  const dir = a.endsWith("/") ? a : a + "/";
  return f.startsWith(dir) ? dir.length : 0;
}

/**
 * Report files changed by a commit/PR/agent session. For each file, the most
 * specifically-anchored nodes are marked stale (so a tweak to service.ts flags
 * the "service layer" node, not every node anchored at src/**).
 */
export async function reportChanges(actor: Actor, projectRef: string, input: { files: string[]; sha?: string; summary?: string }) {
  const db = await getDb();
  const project = await getProject(actor, projectRef);
  const files = [...new Set(input.files.map(normPath).filter(Boolean))];
  if (!files.length) throw new ServiceError("invalid", "files is empty");
  const ns = await db.select().from(nodes).where(eq(nodes.projectId, project.id));
  const hits = new Map<string, { node: NodeRow; files: string[] }>();
  for (const f of files) {
    // Most specific match per layer: a change to service.ts flags the
    // "service.ts" code node and the "Service layer" system node, not every
    // node anchored at src/**.
    const best: Partial<Record<Layer, { score: number; nodes: NodeRow[] }>> = {};
    for (const n of ns) {
      const s = Math.max(0, ...n.anchors.map((a) => anchorScore(a, f)));
      if (!s) continue;
      const b = best[n.layer];
      if (!b || s > b.score) best[n.layer] = { score: s, nodes: [n] };
      else if (s === b.score) b.nodes.push(n);
    }
    for (const n of Object.values(best).flatMap((b) => b!.nodes)) {
      const h = hits.get(n.id) ?? { node: n, files: [] };
      h.files.push(f);
      hits.set(n.id, h);
    }
  }
  const short = input.sha ? input.sha.slice(0, 8) : null;
  // Changes at the commit a node was described at aren't news.
  for (const [id, { node }] of hits) {
    if (input.sha && node.describedSha && (input.sha.startsWith(node.describedSha) || node.describedSha.startsWith(input.sha))) hits.delete(id);
  }
  return db.transaction(async (tx) => {
    for (const { node, files: fs } of hits.values()) {
      const reason = `${fs.slice(0, 3).join(", ")}${fs.length > 3 ? ` +${fs.length - 3} more` : ""} changed${short ? ` in ${short}` : ""}${input.summary ? `: ${input.summary}` : ""}`;
      await tx.update(nodes).set({ stale: true, staleSource: "report", staleReason: reason.slice(0, 500) }).where(eq(nodes.id, node.id));
    }
    const marked = [...hits.values()].map(({ node, files: fs }) => ({ name: node.name, layer: node.layer, files: fs }));
    await emit(tx, actor, project.id, {
      type: "code.changed",
      entity: "project",
      entityId: project.id,
      summary: `reported ${files.length} changed file(s)${short ? ` (${short})` : ""}; ${marked.length} map node(s) need re-describing`,
      data: { sha: input.sha, files: files.slice(0, 50), stale: marked.map((m) => `${m.layer}:${m.name}`) },
    });
    return { files: files.length, staleMarked: marked, unanchored: files.filter((f) => !ns.some((n) => n.anchors.some((a) => anchorScore(a, f)))) };
  });
}

export async function listStale(actor: Actor, projectRef: string) {
  const db = await getDb();
  const project = await getProject(actor, projectRef);
  const rows = await db
    .select({ id: nodes.id, name: nodes.name, layer: nodes.layer, kind: nodes.kind, reason: nodes.staleReason, anchors: nodes.anchors })
    .from(nodes)
    .where(and(eq(nodes.projectId, project.id), eq(nodes.stale, true)));
  return rows;
}

export async function markFresh(actor: Actor, projectRef: string, ref: string, sha?: string) {
  return upsertNode(actor, projectRef, { id: ref, markFresh: true, describedSha: sha });
}

// ───────── decisions ─────────

export type DecisionInput = {
  number?: number;
  title?: string;
  status?: (typeof schema.DECISION_STATUSES)[number];
  context?: string;
  decision?: string;
  consequences?: string;
  nodes?: string[];
};

export async function listDecisions(actor: Actor, projectRef: string) {
  const db = await getDb();
  const project = await getProject(actor, projectRef);
  return db.select().from(decisions).where(eq(decisions.projectId, project.id)).orderBy(asc(decisions.number));
}

/** Create (no number) or update (number) an ADR. */
export async function upsertDecision(actor: Actor, projectRef: string, input: DecisionInput) {
  const db = await getDb();
  const project = await getProject(actor, projectRef);
  return db.transaction(async (tx) => {
    const nodeIds = input.nodes ? await Promise.all(input.nodes.map(async (r) => (await resolveNode(tx, project.id, r)).id)) : undefined;
    if (input.number !== undefined) {
      const [d] = await tx.select().from(decisions).where(and(eq(decisions.projectId, project.id), eq(decisions.number, input.number)));
      if (!d) throw new ServiceError("not_found", `Decision ADR-${input.number} not found`);
      const patch = {
        title: input.title,
        status: input.status,
        context: input.context,
        decision: input.decision,
        consequences: input.consequences,
        nodeIds,
      };
      const changes = diff(d as unknown as Record<string, unknown>, patch as Record<string, unknown>);
      if (!Object.keys(changes).length) return d;
      const [u] = await tx
        .update(decisions)
        .set({ ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), version: d.version + 1, updatedAt: new Date() })
        .where(eq(decisions.id, d.id))
        .returning();
      await emit(tx, actor, project.id, {
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
      .where(eq(decisions.projectId, project.id));
    const [d] = await tx
      .insert(decisions)
      .values({
        projectId: project.id,
        number: Number(max) + 1,
        title: input.title.trim(),
        status: input.status ?? "accepted",
        context: input.context ?? "",
        decision: input.decision ?? "",
        consequences: input.consequences ?? "",
        nodeIds: nodeIds ?? [],
        authorKind: actor.kind,
        authorName: actor.name,
      })
      .returning();
    await emit(tx, actor, project.id, {
      type: "decision.created",
      entity: "decision",
      entityId: d.id,
      summary: `recorded ADR-${d.number} "${d.title}"`,
      data: { number: d.number },
    });
    return d;
  });
}

// ───────── glossary ─────────

export async function listTerms(actor: Actor, projectRef: string) {
  const db = await getDb();
  const project = await getProject(actor, projectRef);
  return db.select().from(terms).where(eq(terms.projectId, project.id)).orderBy(asc(terms.term));
}

export async function upsertTerm(actor: Actor, projectRef: string, input: { term: string; definition: string; node?: string | null }) {
  const db = await getDb();
  const project = await getProject(actor, projectRef);
  const term = input.term?.trim();
  if (!term || !input.definition?.trim()) throw new ServiceError("invalid", "term and definition are required");
  return db.transaction(async (tx) => {
    const nodeId = input.node === null ? null : input.node ? (await resolveNode(tx, project.id, input.node)).id : undefined;
    const [existing] = await tx
      .select()
      .from(terms)
      .where(and(eq(terms.projectId, project.id), eq(sql`lower(${terms.term})`, term.toLowerCase())));
    if (existing) {
      if (existing.definition === input.definition.trim() && (nodeId === undefined || nodeId === existing.nodeId) && existing.term === term) return existing;
      const [t] = await tx
        .update(terms)
        .set({ term, definition: input.definition.trim(), ...(nodeId !== undefined ? { nodeId } : {}), updatedAt: new Date() })
        .where(eq(terms.id, existing.id))
        .returning();
      await emit(tx, actor, project.id, { type: "term.updated", entity: "term", entityId: t.id, summary: `updated glossary term "${t.term}"` });
      return t;
    }
    const [t] = await tx
      .insert(terms)
      .values({ projectId: project.id, term, definition: input.definition.trim(), nodeId: nodeId ?? null })
      .returning();
    await emit(tx, actor, project.id, { type: "term.created", entity: "term", entityId: t.id, summary: `defined glossary term "${t.term}"` });
    return t;
  });
}

export async function deleteTerm(actor: Actor, projectRef: string, term: string) {
  const db = await getDb();
  const project = await getProject(actor, projectRef);
  const [t] = await db
    .select()
    .from(terms)
    .where(and(eq(terms.projectId, project.id), isUuid(term) ? eq(terms.id, term) : eq(sql`lower(${terms.term})`, term.toLowerCase())));
  if (!t) throw new ServiceError("not_found", `Term "${term}" not found`);
  await db.delete(terms).where(eq(terms.id, t.id));
  await emit(db, actor, project.id, { type: "term.deleted", entity: "term", entityId: t.id, summary: `removed glossary term "${t.term}"` });
  return { ok: true };
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
 * Where an agent's queue starts in a project. With no explicit cursor, a key
 * starts at the moment it was created: a new agent doesn't inherit the whole
 * project history as "unread".
 */
async function cursorFor(q: Q, key: { id: string; createdAt: Date }, projectId: string) {
  const [cur] = await q
    .select()
    .from(agentCursors)
    .where(and(eq(agentCursors.apiKeyId, key.id), eq(agentCursors.projectId, projectId)));
  if (cur) return cur.lastSeq;
  const [row] = await q
    .select({ seq: sql<number>`coalesce(max(${events.seq}), 0)` })
    .from(events)
    .where(and(eq(events.projectId, projectId), sql`${events.createdAt} <= ${key.createdAt}`));
  return Number(row?.seq ?? 0);
}

async function keyRow(q: Q, keyId: string) {
  const [k] = await q.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, keyId));
  if (!k) throw new ServiceError("not_found", "API key not found");
  return k;
}

const notMine = (keyId: string) => or(ne(events.actorKind, "agent"), ne(events.actorId, keyId));

/**
 * The AI queue: changes since this agent's cursor, excluding the agent's own
 * writes. Humans rearranging the board, editing tickets, or commenting show up
 * here. Call `ackChanges` with the last seq you processed.
 *
 * Large backlogs come back as a summary (counts by type and by who) plus the
 * oldest `limit` changes, so an agent returning after a long break isn't
 * flooded; `latestSeq` lets it ack everything once it has skimmed the summary.
 */
export async function getChanges(actor: Actor, projectRef: string, limit = 50) {
  if (actor.kind !== "agent") throw new ServiceError("forbidden", "The change queue is per agent API key");
  const db = await getDb();
  const project = await getProject(actor, projectRef);
  const after = await cursorFor(db, await keyRow(db, actor.id), project.id);
  const pending = and(eq(events.projectId, project.id), gt(events.seq, after), notMine(actor.id));
  const cap = Math.min(Math.max(limit, 1), 200);
  const rows = await db.select().from(events).where(pending).orderBy(asc(events.seq)).limit(cap);
  const [{ total, latest }] = await db
    .select({ total: sql<number>`count(*)::int`, latest: sql<number>`coalesce(max(${events.seq}), 0)` })
    .from(events)
    .where(pending);
  const summary =
    Number(total) > cap
      ? {
          byType: Object.fromEntries(
            (
              await db
                .select({ type: events.type, n: sql<number>`count(*)::int` })
                .from(events)
                .where(pending)
                .groupBy(events.type)
            ).map((r) => [r.type, Number(r.n)]),
          ),
          byActor: Object.fromEntries(
            (
              await db
                .select({ who: events.actorName, n: sql<number>`count(*)::int` })
                .from(events)
                .where(pending)
                .groupBy(events.actorName)
            ).map((r) => [r.who, Number(r.n)]),
          ),
          note: `Showing the oldest ${cap} of ${total} changes. Skim the summary, check get_board for current state, then ack_changes with latestSeq (${latest}) to catch up, or page through by acking the last seq shown.`,
        }
      : undefined;
  // Map nodes whose code changed since they were last described: re-read the
  // anchored files and update the explainer (that clears the flag).
  const stale = await db
    .select({ name: nodes.name, layer: nodes.layer, reason: nodes.staleReason, anchors: nodes.anchors })
    .from(nodes)
    .where(and(eq(nodes.projectId, project.id), eq(nodes.stale, true)))
    .limit(50);
  return {
    cursor: after,
    total: Number(total),
    latestSeq: Number(latest) || after,
    changes: rows,
    hasMore: Number(total) > rows.length,
    ...(summary ? { summary } : {}),
    staleNodes: stale,
  };
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

/**
 * Human reset: mark everything as seen for one agent key (or every key), in one
 * project or all of the team's projects. Used after demos, long breaks, or when
 * a backlog isn't worth replaying.
 */
export async function markAllSeen(actor: Actor, opts: { keyId?: string; projectRef?: string } = {}) {
  if (actor.kind !== "human") throw new ServiceError("forbidden", "Only teammates can reset an agent's queue");
  const db = await getDb();
  const keys = await db
    .select({ id: schema.apiKeys.id })
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.teamId, actor.teamId), opts.keyId ? eq(schema.apiKeys.id, opts.keyId) : undefined));
  if (opts.keyId && !keys.length) throw new ServiceError("not_found", "API key not found");
  const ps = opts.projectRef ? [await getProject(actor, opts.projectRef)] : await listProjects(actor);
  let reset = 0;
  await db.transaction(async (tx) => {
    for (const p of ps) {
      const [{ head }] = await tx
        .select({ head: sql<number>`coalesce(max(${events.seq}), 0)` })
        .from(events)
        .where(eq(events.projectId, p.id));
      for (const k of keys) {
        await tx
          .insert(agentCursors)
          .values({ apiKeyId: k.id, projectId: p.id, lastSeq: Number(head) })
          .onConflictDoUpdate({ target: [agentCursors.apiKeyId, agentCursors.projectId], set: { lastSeq: sql`greatest(${agentCursors.lastSeq}, ${Number(head)})` } });
        reset++;
      }
    }
  });
  return { ok: true, reset };
}

/** Pending queue depth per agent key, shown in the UI so humans know what the AI hasn't seen yet. */
export async function queueStatus(actor: Actor, projectRef: string) {
  const db = await getDb();
  const project = await getProject(actor, projectRef);
  const keys = await db
    .select({ id: schema.apiKeys.id, name: schema.apiKeys.name, lastUsedAt: schema.apiKeys.lastUsedAt, createdAt: schema.apiKeys.createdAt })
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.teamId, actor.teamId), sql`${schema.apiKeys.revokedAt} is null`));
  const out = [];
  for (const { createdAt, ...k } of keys) {
    const after = await cursorFor(db, { id: k.id, createdAt }, project.id);
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(events)
      .where(and(eq(events.projectId, project.id), gt(events.seq, after), notMine(k.id)));
    out.push({ ...k, pending: Number(n) });
  }
  return out;
}
