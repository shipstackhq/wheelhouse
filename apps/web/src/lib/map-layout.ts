// Auto-layout engines for the knowledge map (WH-21/WH-23), shared by every lens.
// Pure functions over plain position/size data — no React Flow or DOM imports — so they're
// unit-testable and the lens-switching UI in knowledge-map.tsx can stay thin.
import dagre from "@dagrejs/dagre";

export type LayoutNode = {
  id: string;
  width: number;
  height: number;
  parentId?: string | null;
};
export type LayoutEdge = { source: string; target: string };
export type Direction = "LR" | "TB";

export type LayoutResult = Map<string, { x: number; y: number }>;

const SPACING = { nodesep: 56, ranksep: 120, edgesep: 32 };

/**
 * Dagre layout for a flat-ish lens (concept, data, code-as-flat-fallback).
 * WH-23: dependency edges must read left→right, i.e. x(target) > x(source) for a "depends on"
 * edge target→dependency. Our `depends`/`references` edges point from the dependent node to the
 * thing it depends on (fromNodeId = dependent, toNodeId = dependency), so to get the dependent
 * sitting to the RIGHT of what it depends on, we feed dagre the edge REVERSED (toNodeId -> fromNodeId)
 * under rankdir "LR": dagre places edge sources to the left of targets, so source=dependency,
 * target=dependent gives dependency-left, dependent-right, matching "a node sits to the right of
 * everything pointing into it."
 */
export function dagreLayout(nodes: LayoutNode[], edges: LayoutEdge[], dir: Direction = "LR"): LayoutResult {
  const g = new dagre.graphlib.Graph({ compound: false });
  g.setGraph({ rankdir: dir, ...SPACING, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) g.setNode(n.id, { width: n.width, height: n.height });
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target) || e.source === e.target) continue;
    // Reversed on purpose — see function doc.
    g.setEdge(e.target, e.source);
  }
  dagre.layout(g);
  const out: LayoutResult = new Map();
  for (const n of nodes) {
    const p = g.node(n.id);
    if (p) out.set(n.id, { x: Math.round(p.x - n.width / 2), y: Math.round(p.y - n.height / 2) });
  }
  return out;
}

/**
 * Simple top-down/left-right tree layout for the Code lens: directories/files/symbols/endpoints
 * are inherently hierarchical via parentId, so a full graph-layout engine is overkill. Lays out
 * each root's subtree depth-first, stacking siblings along the cross-axis and advancing depth
 * along the main axis, left→right (WH-23) or top→bottom.
 */
export function treeLayout(nodes: LayoutNode[], edges: LayoutEdge[], dir: Direction = "LR"): LayoutResult {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map<string, LayoutNode[]>();
  const hasParent = new Set<string>();
  for (const n of nodes) {
    if (n.parentId && byId.has(n.parentId)) {
      kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);
      hasParent.add(n.id);
    }
  }
  // Extra non-hierarchy edges (depends) nudge rank but the tree shape still comes from parentId;
  // fall back to treating edge targets as "children" for any node with no real parent, so orphaned
  // dependency chains still spread out instead of stacking at the origin.
  if (!kids.size) {
    for (const e of edges) {
      if (!byId.has(e.source) || !byId.has(e.target) || hasParent.has(e.target)) continue;
      kids.set(e.source, [...(kids.get(e.source) ?? []), byId.get(e.target)!]);
      hasParent.add(e.target);
    }
  }
  const roots = nodes.filter((n) => !hasParent.has(n.id));
  const out: LayoutResult = new Map();
  const GAP_MAIN = 90;
  const GAP_CROSS = 24;
  let cross = 0; // running offset along the cross-axis (y for LR, x for TB)

  const place = (n: LayoutNode, depth: number): number => {
    const main = depth * (dir === "LR" ? 260 : 0) + depth * (dir === "LR" ? 0 : 0);
    const children = kids.get(n.id) ?? [];
    const crossSize = dir === "LR" ? n.height : n.width;
    if (!children.length) {
      const pos = dir === "LR" ? { x: depth * (200 + GAP_MAIN), y: cross } : { x: cross, y: depth * (80 + GAP_MAIN) };
      out.set(n.id, pos);
      cross += crossSize + GAP_CROSS;
      return pos[dir === "LR" ? "y" : "x"];
    }
    const start = cross;
    for (const c of children) place(c, depth + 1);
    const end = cross - GAP_CROSS;
    const mid = Math.round((start + end - crossSize) / 2);
    const pos = dir === "LR" ? { x: depth * (200 + GAP_MAIN), y: Math.max(start, mid) } : { x: Math.max(start, mid), y: depth * (80 + GAP_MAIN) };
    out.set(n.id, pos);
    void main;
    return pos[dir === "LR" ? "y" : "x"];
  };
  for (const r of roots) place(r, 0);
  return out;
}

// ───────── ELK (Systems lens: nested modules) ─────────

export type ElkInput = {
  id: string;
  width: number;
  height: number;
  parentId?: string | null;
};

let elkModulePromise: Promise<typeof import("elkjs/lib/elk.bundled.js")> | null = null;
function loadElk() {
  // Lazy, client-only: elkjs is a large WASM-backed layout engine only needed when someone
  // actually opens/tidies the Systems lens — same lazy-load rationale as Lexical in description-editor.tsx.
  if (!elkModulePromise) elkModulePromise = import("elkjs/lib/elk.bundled.js");
  return elkModulePromise;
}

/**
 * Hierarchical layout for the Systems lens via ELK's layered algorithm, which natively
 * understands nested children (unlike dagre, which is flat). Builds ELK's own nested
 * `children`/`edges` tree from each node's real parentId, matching the nesting React Flow
 * already renders via node.parentId/extent:"parent".
 */
export async function elkLayout(nodes: ElkInput[], edges: LayoutEdge[], dir: Direction = "LR"): Promise<LayoutResult> {
  const ELK = (await loadElk()).default;
  const elk = new ELK();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childrenOf = new Map<string, ElkInput[]>();
  for (const n of nodes) if (n.parentId && byId.has(n.parentId)) childrenOf.set(n.parentId, [...(childrenOf.get(n.parentId) ?? []), n]);

  // Edges are assigned to the lowest common ancestor's container in ELK's model; since our
  // graphs are shallow (service -> module, rarely deeper) and cross-container edges are common,
  // simplest correct approach: lift every edge to the root graph (ELK allows this for layered
  // layout — "hierarchical edges" are supported via edge nesting, but flattening is adequate here
  // and keeps edges drawn correctly without extra hierarchical-edge bookkeeping).
  const toElkNode = (n: ElkInput): Record<string, unknown> => {
    const kids = childrenOf.get(n.id) ?? [];
    return {
      id: n.id,
      width: n.width,
      height: n.height,
      ...(kids.length
        ? {
            children: kids.map(toElkNode),
            layoutOptions: { "elk.algorithm": "layered", "elk.direction": dir === "LR" ? "RIGHT" : "DOWN" },
          }
        : {}),
    };
  };
  const roots = nodes.filter((n) => !n.parentId || !byId.has(n.parentId));
  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": dir === "LR" ? "RIGHT" : "DOWN",
      "elk.spacing.nodeNode": "48",
      "elk.layered.spacing.nodeNodeBetweenLayers": "100",
      "elk.spacing.edgeNode": "24",
      "elk.spacing.edgeEdge": "16",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "16",
      "elk.layered.mergeEdges": "true",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
    },
    children: roots.map(toElkNode),
    edges: edges
      .filter((e) => byId.has(e.source) && byId.has(e.target) && e.source !== e.target)
      // WH-23: same reversal rationale as dagreLayout — ELK's layered algo places edge
      // sources "earlier" (left/up) than targets, and our edges point dependent -> dependency.
      .map((e) => ({ id: `${e.target}-${e.source}`, sources: [e.target], targets: [e.source] })),
  };
  const res = (await elk.layout(graph as unknown as Parameters<InstanceType<typeof ELK>["layout"]>[0])) as {
    children?: Array<{ id: string; x?: number; y?: number; children?: unknown[] }>;
  };
  const out: LayoutResult = new Map();
  // ELK positions children relative to their parent container's origin; our nodes use the same
  // convention (React Flow positions nested nodes relative to their parentId), so no flattening needed.
  const walk = (list: Array<{ id: string; x?: number; y?: number; children?: unknown[] }> | undefined) => {
    if (!list) return;
    for (const c of list) {
      out.set(c.id, { x: Math.round(c.x ?? 0), y: Math.round(c.y ?? 0) });
      walk(c.children as typeof list);
    }
  };
  walk(res.children);
  return out;
}

/**
 * WH-23: detect cycles in a directed graph and return an acyclic edge list suitable for
 * rank assignment, reversing one edge per cycle rather than dropping it (callers still draw
 * the original edges — this is only consumed as layout-engine input). A simple DFS-based
 * white/grey/black walk: any edge to a "grey" (in-progress) node is a back-edge and gets
 * reversed to break the cycle. "Weakest edge" proxy: the back-edge found by DFS — i.e. the
 * edge that closes the cycle at the point the search reaches it — since the schema carries no
 * edge-weight or recency field the client can see; dagre's own graphlib has `alg.findCycles`/
 * acyclic utilities, but they operate on a constructed graphlib.Graph rather than our plain
 * edge-list input across callers (dagreLayout/elkLayout/treeLayout), so a small dedicated
 * detector keeps this reusable and unit-testable without instantiating a graphlib Graph first.
 */
export function breakCycles(nodeIds: string[], edges: LayoutEdge[]): LayoutEdge[] {
  const adj = new Map<string, LayoutEdge[]>();
  for (const id of nodeIds) adj.set(id, []);
  for (const e of edges) {
    if (!adj.has(e.source) || !adj.has(e.target)) continue;
    adj.get(e.source)!.push(e);
  }
  const color = new Map<string, 0 | 1 | 2>(); // 0 = white, 1 = grey (on stack), 2 = black (done)
  const out: LayoutEdge[] = [];
  const visit = (id: string) => {
    color.set(id, 1);
    for (const e of adj.get(id) ?? []) {
      const c = color.get(e.target) ?? 0;
      if (c === 1) out.push({ source: e.target, target: e.source }); // back-edge: reverse it
      else {
        out.push(e);
        if (c === 0) visit(e.target);
      }
    }
    color.set(id, 2);
  };
  for (const id of nodeIds) if (!color.has(id)) visit(id);
  return out;
}

/** WH-23: check whether a dragged node's new x violates "sits right of everything pointing into it." */
export function violatesLeftToRight(
  nodeId: string,
  newX: number,
  nodeWidthOf: (id: string) => number,
  incomingSourceIds: string[],
  xOf: (id: string) => number | undefined,
): { violates: boolean; minX: number } {
  let minX = -Infinity;
  for (const srcId of incomingSourceIds) {
    const sx = xOf(srcId);
    if (sx === undefined) continue;
    const required = sx + nodeWidthOf(srcId) + 40; // a little breathing room past the source's right edge
    if (required > minX) minX = required;
  }
  return { violates: minX > -Infinity && newX < minX, minX: minX === -Infinity ? newX : minX };
}
