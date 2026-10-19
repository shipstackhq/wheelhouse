import type { Actor } from "./access";
import { askEnabled, askMap } from "./ask";
import { rateLimit } from "./rate-limit";
import * as schema from "../db/schema";
import * as svc from "./service";
import { ServiceError } from "./service";
import { bad, finite, oneOf, rateLimited, text, textList, textOrNull, whole } from "./web-input";

/**
 * What the web app's map, decisions, glossary and activity pages read and write (WH-97), as functions of the signed-in person.
 * The API's controllers call these and nothing else. Everything is scoped by the actor's workspace through the service layer, so another
 * workspace's project, node, edge, flow, decision or term is "not found". Answers carry only what the screens use, never raw rows.
 */

type Body = Record<string, unknown>;

// ───────── views ─────────

export type NodeView = {
  id: string;
  parentId: string | null;
  layer: schema.Layer;
  kind: string;
  name: string;
  summary: string;
  purpose: string;
  responsibilities: string;
  interfaces: string;
  gotchas: string;
  details: string;
  anchors: string[];
  columns: schema.Column[];
  indexes: schema.Index[];
  describedSha: string | null;
  describedAt: Date | null;
  stale: boolean;
  staleReason: string | null;
  status: "planned" | "building" | "live" | "deprecated";
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  placed: boolean;
  version: number;
};

export const nodeView = (n: svc.NodeRow): NodeView => ({
  id: n.id,
  parentId: n.parentId,
  layer: n.layer,
  kind: n.kind,
  name: n.name,
  summary: n.summary,
  purpose: n.purpose,
  responsibilities: n.responsibilities,
  interfaces: n.interfaces,
  gotchas: n.gotchas,
  details: n.details,
  anchors: n.anchors,
  columns: n.columns,
  indexes: n.indexes,
  describedSha: n.describedSha,
  describedAt: n.describedAt,
  stale: n.stale,
  staleReason: n.staleReason,
  status: n.status,
  x: n.x,
  y: n.y,
  width: n.width,
  height: n.height,
  placed: n.placed,
  version: n.version,
});

type EdgeRow = typeof schema.edges.$inferSelect;
export type EdgeView = { id: string; kind: string; fromNodeId: string; toNodeId: string; label: string; meta: schema.EdgeMeta };
const edgeView = (e: EdgeRow): EdgeView => ({ id: e.id, kind: e.kind, fromNodeId: e.fromNodeId, toNodeId: e.toNodeId, label: e.label, meta: e.meta });

type FlowRow = typeof schema.flows.$inferSelect;
export type FlowView = { id: string; name: string; description: string; steps: schema.FlowStep[]; version: number };
export const flowView = (f: FlowRow): FlowView => ({ id: f.id, name: f.name, description: f.description, steps: f.steps, version: f.version });

type DecisionRow = typeof schema.decisions.$inferSelect;
export type DecisionView = {
  id: string;
  number: number;
  title: string;
  status: (typeof schema.DECISION_STATUSES)[number];
  context: string;
  decision: string;
  consequences: string;
  nodeIds: string[];
  authorKind: "human" | "agent";
  authorName: string;
  version: number;
  updatedAt: Date;
};
export const decisionView = (d: DecisionRow): DecisionView => ({
  id: d.id,
  number: d.number,
  title: d.title,
  status: d.status,
  context: d.context,
  decision: d.decision,
  consequences: d.consequences,
  nodeIds: d.nodeIds,
  authorKind: d.authorKind,
  authorName: d.authorName,
  version: d.version,
  updatedAt: d.updatedAt,
});

type TermRow = typeof schema.terms.$inferSelect;
export type TermView = { id: string; term: string; definition: string; nodeId: string | null };
export const termView = (t: TermRow): TermView => ({ id: t.id, term: t.term, definition: t.definition, nodeId: t.nodeId });

/** Nodes whose files someone is changing right now (not landed yet), and the map updates waiting for that code. */
export type FluxView = Record<
  string,
  {
    sessions: { id: string; by: string; ticket: string | null; files: string[] }[];
    drafts: { id: string; authorKind: "human" | "agent"; authorName: string; confirm: boolean; patch: Record<string, unknown> }[];
  }
>;

export type GraphView = {
  project: { id: string; key: string; name: string; description: string };
  nodes: NodeView[];
  edges: EdgeView[];
  ticketLinks: { nodeId: string; ticketId: string; number: number; title: string; columnId: string; ref: string }[];
  flows: FlowView[];
  decisions: DecisionView[];
  terms: TermView[];
  flux: FluxView;
  /** Whether Ask can be used on this server. The key itself never leaves it. */
  askEnabled: boolean;
};

/** The whole map of a project in one read: what the map, decisions and glossary pages draw. */
export async function graphView(actor: Actor, projectKey: string): Promise<GraphView> {
  const g = await svc.getGraph(actor, projectKey);
  return {
    project: { id: g.project.id, key: g.project.key, name: g.project.name, description: g.project.description },
    nodes: g.nodes.map(nodeView),
    edges: g.edges.map(edgeView),
    ticketLinks: g.ticketLinks.map((l) => ({ nodeId: l.nodeId, ticketId: l.ticketId, number: l.number, title: l.title, columnId: l.columnId, ref: l.ref })),
    flows: g.flows.map(flowView),
    decisions: g.decisions.map(decisionView),
    terms: g.terms.map(termView),
    flux: Object.fromEntries(
      Object.entries(g.flux).map(([id, f]) => [
        id,
        { sessions: f.sessions, drafts: f.drafts.map((d) => ({ id: d.id, authorKind: d.authorKind, authorName: d.authorName, confirm: d.confirm, patch: d.patch })) },
      ]),
    ),
    askEnabled: askEnabled(),
  };
}

// ───────── reading request bodies ─────────

const COLUMN_TEXT = ["name", "type", "default", "references", "onDelete", "note"] as const;

function columnsField(b: Body): schema.Column[] | undefined {
  const v = b.columns;
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 500) return bad("columns", "columns must be a list (at most 500)");
  return v.map((c, i) => {
    if (!c || typeof c !== "object" || Array.isArray(c)) return bad("columns", `column ${i + 1} must be an object`);
    const o = c as Body;
    for (const k of COLUMN_TEXT) if (o[k] !== undefined && typeof o[k] !== "string") return bad("columns", `column ${i + 1}: ${k} must be text`);
    for (const k of ["nullable", "pk", "unique"]) if (o[k] !== undefined && typeof o[k] !== "boolean") return bad("columns", `column ${i + 1}: ${k} must be true or false`);
    return o as unknown as schema.Column;
  });
}

function indexesField(b: Body): schema.Index[] | undefined {
  const v = b.indexes;
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 200) return bad("indexes", "indexes must be a list");
  return v.map((x, i) => {
    const o = x as Body;
    if (!o || typeof o !== "object" || !Array.isArray(o.columns) || o.columns.some((c) => typeof c !== "string")) return bad("indexes", `index ${i + 1} needs a list of column names`);
    return { columns: o.columns as string[], ...(typeof o.name === "string" ? { name: o.name } : {}), ...(o.unique === true ? { unique: true } : {}) };
  });
}

/** The node fields a person can set from the panel, checked. `version` is the lock (read separately). */
export function nodeInput(b: Body): svc.NodeInput {
  const out: svc.NodeInput = {};
  const name = text(b, "name", { max: 200 });
  if (name !== undefined) out.name = name;
  for (const k of ["summary", "purpose", "responsibilities", "interfaces", "gotchas", "details"] as const) {
    const v = text(b, k, { max: 100_000 });
    if (v !== undefined) out[k] = v;
  }
  const layer = oneOf(b, "layer", schema.LAYERS);
  if (layer) out.layer = layer;
  const kind = text(b, "kind", { max: 40 });
  if (kind !== undefined) out.kind = kind as (typeof schema.NODE_KINDS)[number];
  const status = oneOf(b, "status", ["planned", "building", "live", "deprecated"] as const);
  if (status) out.status = status;
  const parent = textOrNull(b, "parent");
  if (parent !== undefined) out.parent = parent;
  const anchors = textList(b, "anchors");
  if (anchors) out.anchors = anchors.map((a) => a.trim()).filter(Boolean);
  const columns = columnsField(b);
  if (columns) out.columns = columns;
  const indexes = indexesField(b);
  if (indexes) out.indexes = indexes;
  return out;
}

/**
 * A stale `version` is a 409 whose `details.current` is what the entity is now. The service attaches the raw row; the web app gets
 * the same trimmed view every other answer uses.
 */
async function withCurrent<T>(run: () => Promise<T>, view: (raw: never) => unknown): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof ServiceError && e.code === "conflict") {
      const raw = (e.details as { current?: unknown } | undefined)?.current;
      if (raw) throw new ServiceError("conflict", e.message, { current: view(raw as never) });
    }
    throw e;
  }
}

/** Create (no id) or change (id) a node. With `version`, a change made by anyone since is a 409 and nothing is overwritten. */
export async function upsertNodeAs(actor: Actor, projectKey: string, b: Body & { id?: string }) {
  const input = nodeInput(b);
  const id = text(b, "id");
  if (id !== undefined) input.id = id;
  const version = whole(b, "version");
  if (version !== undefined) input.expectedVersion = version;
  if (!id && !input.name) bad("name", "name is required to create a node");
  const n = await withCurrent(() => svc.upsertNode(actor, projectKey, input), nodeView as (raw: never) => unknown);
  return nodeView(n as svc.NodeRow);
}

/** Positions (and sizes) of many nodes at once, from a drag, a resize or a Tidy. `placed` says whether a person placed them. */
export function layoutInput(b: Body): { positions: { id: string; x: number; y: number; width?: number; height?: number }[]; placed?: boolean } {
  const v = b.positions;
  if (!Array.isArray(v) || v.length === 0 || v.length > 2000) return bad("positions", "positions must be a list of 1 to 2000 entries");
  const positions = v.map((p, i) => {
    const o = p as Body;
    if (!o || typeof o !== "object" || typeof o.id !== "string") return bad("positions", `position ${i + 1} needs a node id`);
    const out: { id: string; x: number; y: number; width?: number; height?: number } = { id: o.id, x: finite(o.x, "positions"), y: finite(o.y, "positions") };
    if (o.width !== undefined) out.width = finite(o.width, "positions");
    if (o.height !== undefined) out.height = finite(o.height, "positions");
    return out;
  });
  if (b.placed !== undefined && typeof b.placed !== "boolean") return bad("placed", "placed must be true or false");
  return { positions, placed: b.placed as boolean | undefined };
}

export async function saveLayoutAs(actor: Actor, projectKey: string, b: Body) {
  const { positions, placed } = layoutInput(b);
  await svc.saveLayout(actor, projectKey, positions, placed === undefined ? undefined : { placed });
  return { ok: true as const };
}

/** A connection between two nodes, by id (or name). `depends` within a layer, `implements` from a lower layer to a higher one. */
export async function connectAs(actor: Actor, projectKey: string, b: Body): Promise<EdgeView> {
  const from = text(b, "from", { required: true });
  const to = text(b, "to", { required: true });
  const kind = oneOf(b, "kind", ["depends", "implements"] as const) ?? "depends";
  const label = text(b, "label", { max: 200 });
  return edgeView(await svc.upsertEdge(actor, projectKey, { from: from!, to: to!, label, kind }));
}

// ───────── flows, decisions, terms ─────────

export async function upsertFlowAs(actor: Actor, projectKey: string, b: Body): Promise<FlowView> {
  const name = text(b, "name", { required: true, max: 200, trim: true })!;
  let steps: svc.FlowInput["steps"];
  if (b.steps !== undefined) {
    if (!Array.isArray(b.steps) || b.steps.length > 200) return bad("steps", "steps must be a list (at most 200)");
    steps = b.steps.map((s, i) => {
      const o = s as Body;
      if (!o || typeof o !== "object") return bad("steps", `step ${i + 1} must be an object`);
      return { node: text(o, "node", { required: true }) ?? bad("steps", `step ${i + 1} needs a node`), title: text(o, "title", { required: true, max: 500 }) ?? "", detail: text(o, "detail", { max: 20_000 }) };
    });
  }
  const input: svc.FlowInput = { name, description: text(b, "description", { max: 5000 }), steps, expectedVersion: whole(b, "version") };
  const id = text(b, "id");
  if (id !== undefined) input.id = id;
  return flowView(await withCurrent(() => svc.upsertFlow(actor, projectKey, input), flowView as (raw: never) => unknown));
}

export async function upsertDecisionAs(actor: Actor, projectKey: string, b: Body): Promise<DecisionView> {
  const input: svc.DecisionInput = {
    number: whole(b, "number"),
    title: text(b, "title", { max: 300 }),
    status: oneOf(b, "status", schema.DECISION_STATUSES),
    context: text(b, "context", { max: 50_000 }),
    decision: text(b, "decision", { max: 50_000 }),
    consequences: text(b, "consequences", { max: 50_000 }),
    nodes: textList(b, "nodes"),
    expectedVersion: whole(b, "version"),
  };
  return decisionView(await withCurrent(() => svc.upsertDecision(actor, projectKey, input), decisionView as (raw: never) => unknown));
}

export async function upsertTermAs(actor: Actor, projectKey: string, term: string, b: Body): Promise<TermView> {
  const definition = text(b, "definition", { required: true, max: 5000 })!;
  const node = textOrNull(b, "node");
  return termView(await svc.upsertTerm(actor, projectKey, { term, definition, node }));
}

// ───────── Ask the map ─────────

/** One person may ask this many questions in a window: every answer is a paid call. */
export const ASK_LIMIT = { count: 20, windowMs: 10 * 60_000 };

/**
 * Ask a question of the map. Order matters: the project is resolved first (another workspace's is a 404 before anything else happens),
 * then the limit is counted, and only then does the server call Claude. The API key is read from the server's environment by
 * `askMap` and is in no answer.
 */
export async function askAs(actor: Actor, projectKey: string, b: Body) {
  await svc.getProject(actor, projectKey);
  const question = text(b, "question", { required: true, max: 4000, trim: true })!;
  const focus = text(b, "focus");
  const hit = rateLimit(`ask:${actor.id}`, ASK_LIMIT.count, ASK_LIMIT.windowMs);
  if (!hit.ok) throw rateLimited(hit.retryAfter);
  return askMap(actor, projectKey, question, focus || undefined);
}

// ───────── activity ─────────

export type ActivityEvent = {
  seq: number;
  actorKind: "human" | "agent";
  actorName: string;
  type: string;
  entity: string;
  entityId: string | null;
  summary: string;
  data: { ref?: string; number?: number; body?: string };
  createdAt: Date;
};

/** The project's recent events, newest first, optionally only by agents or only by people. `data` carries only what the page links with. */
export async function activityView(actor: Actor, projectKey: string, who?: string): Promise<ActivityEvent[]> {
  const actorKind = who === "agent" || who === "human" ? who : undefined;
  const events = await svc.listEvents(actor, projectKey, { limit: 200, actorKind });
  return events.map((e) => {
    const d = (e.data ?? {}) as Record<string, unknown>;
    const data: ActivityEvent["data"] = {};
    if (typeof d.ref === "string") data.ref = d.ref;
    if (typeof d.number === "number") data.number = d.number;
    if (typeof d.body === "string") data.body = d.body.slice(0, 500);
    return { seq: e.seq, actorKind: e.actorKind, actorName: e.actorName, type: e.type, entity: e.entity, entityId: e.entityId, summary: e.summary, data, createdAt: e.createdAt };
  });
}
