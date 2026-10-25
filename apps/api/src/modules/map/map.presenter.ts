import * as schema from "../../db/schema";
import { ServiceError } from "../../common/service-error";
import type { Graph } from "./graph.service";
import type { NodeRow } from "./map.repository";

/** Rows as the API shows them: only what the screens use, never raw rows. */

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

export const nodeView = (n: NodeRow): NodeView => ({
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
export const edgeView = (e: EdgeRow): EdgeView => ({ id: e.id, kind: e.kind, fromNodeId: e.fromNodeId, toNodeId: e.toNodeId, label: e.label, meta: e.meta });

type FlowRow = typeof schema.flows.$inferSelect;
export type FlowView = { id: string; name: string; description: string; steps: schema.FlowStep[]; version: number };
export const flowView = (f: FlowRow): FlowView => ({ id: f.id, name: f.name, description: f.description, steps: f.steps, version: f.version });

type DecisionRow = typeof schema.decisions.$inferSelect & { nodeIds: string[] };
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
    sessions: { id: string; by: string; issue: string | null; files: string[] }[];
    drafts: { id: string; authorKind: "human" | "agent"; authorName: string; confirm: boolean; patch: Record<string, unknown> }[];
  }
>;

export type GraphView = {
  team: { id: string; key: string; name: string; description: string };
  nodes: NodeView[];
  edges: EdgeView[];
  issueLinks: { nodeId: string; issueId: string; number: number; title: string; statusId: string; ref: string }[];
  flows: FlowView[];
  decisions: DecisionView[];
  terms: TermView[];
  flux: FluxView;
  /** Whether Ask can be used on this server. The key itself never leaves it. */
  askEnabled: boolean;
};

/** The whole map of a team in one read: what the map, decisions and glossary pages draw. `askEnabled`: whether Ask can be used on this server (the key itself never leaves it). */
export function graphView(g: Graph, askEnabled: boolean): GraphView {
  return {
    team: { id: g.team.id, key: g.team.key, name: g.team.name, description: g.team.description },
    nodes: g.nodes.map(nodeView),
    edges: g.edges.map(edgeView),
    issueLinks: g.issueLinks.map((l) => ({ nodeId: l.nodeId, issueId: l.issueId, number: l.number, title: l.title, statusId: l.statusId, ref: l.ref })),
    flows: g.flows.map(flowView),
    decisions: g.decisions.map(decisionView),
    terms: g.terms.map(termView),
    flux: Object.fromEntries(
      Object.entries(g.flux).map(([id, f]) => [
        id,
        { sessions: f.sessions, drafts: f.drafts.map((d) => ({ id: d.id, authorKind: d.authorKind, authorName: d.authorName, confirm: d.confirm, patch: d.patch })) },
      ]),
    ),
    askEnabled,
  };
}

/**
 * A stale `version` is a 409 whose `details.current` is what the entity is now. The service attaches the raw row; the web app gets
 * the same trimmed view every other answer uses.
 */
export async function withCurrent<T>(run: () => Promise<T>, view: (raw: never) => unknown): Promise<T> {
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

/** The team's recent events as the page shows them: `data` carries only what the page links with. */
export function activityView(events: { seq: number; actorKind: "human" | "agent"; actorName: string; type: string; entity: string; entityId: string | null; summary: string; data: unknown; createdAt: Date }[]): ActivityEvent[] {
  return events.map((e) => {
    const d = (e.data ?? {}) as Record<string, unknown>;
    const data: ActivityEvent["data"] = {};
    if (typeof d.ref === "string") data.ref = d.ref;
    if (typeof d.number === "number") data.number = d.number;
    if (typeof d.body === "string") data.body = d.body.slice(0, 500);
    return { seq: e.seq, actorKind: e.actorKind, actorName: e.actorName, type: e.type, entity: e.entity, entityId: e.entityId, summary: e.summary, data, createdAt: e.createdAt };
  });
}
