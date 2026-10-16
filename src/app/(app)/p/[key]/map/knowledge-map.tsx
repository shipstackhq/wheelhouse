"use client";

import "@xyflow/react/dist/style.css";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  NodeResizer,
  MarkerType,
  useReactFlow,
  applyNodeChanges,
  type Node,
  type Edge,
  type NodeChange,
  type NodeProps,
  type Connection,
} from "@xyflow/react";
import clsx from "clsx";
import {
  connectNodesAction,
  deleteEdgeAction,
  deleteFlowAction,
  deleteNodeAction,
  getGraphAction,
  markFreshAction,
  resolveDraftAction,
  saveLayoutAction,
  upsertFlowAction,
  upsertNodeAction,
} from "@/app/actions";
import { useDialogs } from "@/components/ui";
import { useResolvedTheme } from "@/components/theme-toggle";
import { GlossaryProvider, Markdown } from "@/components/markdown";
import { AskDialog } from "@/components/ask-dialog";
import {
  KIND_STYLE,
  LAYER_META,
  LAYER_ORDER,
  STATUS_STYLE,
  relatedOnLayer,
  subtree,
  TABLE_HEADER_H,
  TABLE_ROW_H,
  TABLE_W,
  tableHeight,
  type Column,
  type LayerId,
} from "@/lib/map-shared";
import dagre from "@dagrejs/dagre";
import { NodePanel } from "./node-panel";
import { FlowEditor, type FlowDraft } from "./flow-editor";
import { dagreLayout, treeLayout, elkLayout, violatesLeftToRight, breakCycles, type Direction } from "@/lib/map-layout";
import { collapseKey, seenKey, loadCollapsed, saveCollapsed, remapCollapsedEdges } from "@/lib/map-collapse";

export type Graph = Extract<Awaited<ReturnType<typeof getGraphAction>>, { ok: true }>["data"];
export type GNode = Graph["nodes"][number];

const LEAF_W = 200;
const LEAF_H = 64;

type NodeData = {
  n: GNode;
  hasChildren: boolean;
  tickets: number;
  dim: boolean;
  related: boolean;
  flowCurrent: boolean;
  flowVisited: boolean;
  onFocus: (id: string) => void;
  hlCols?: Set<string>; // data layer: highlighted column names
  flux?: { by: string; ticket: string | null; drafts: number } | null;
  onColumnClick?: (nodeId: string, column: string) => void;
  /** WH-22: collapse state for a container node (undefined = not a container). */
  collapsed?: boolean;
  hiddenCount?: number; // descendants hidden while collapsed
  onToggleCollapse?: (id: string) => void;
};

function ringClass(d: NodeData) {
  return d.flowCurrent ? "ring-4 ring-accent/70" : d.related ? "ring-2 ring-agent/70" : d.flowVisited ? "ring-2 ring-accent/30" : "";
}

// ───────── node rendering ─────────

const BoxNode = memo(function BoxNode({ data, selected }: NodeProps<Node<NodeData>>) {
  const { n, hasChildren, tickets, dim, related, flowCurrent, flowVisited } = data;
  const k = KIND_STYLE[n.kind] ?? KIND_STYLE.service;
  const ring = flowCurrent
    ? "ring-4 ring-accent/70"
    : related
      ? "ring-2 ring-agent/70"
      : flowVisited
        ? "ring-2 ring-accent/30"
        : "";
  const stale = (
    <>
      {n.stale && <span className="chip bg-warn/15 text-[9px] text-warn" title={n.staleReason ?? "Code changed"}>⚠ stale</span>}
      {data.flux && <FluxBadge flux={data.flux} />}
    </>
  );

  if (hasChildren) {
    return (
      <div
        className={clsx(
          "h-full w-full rounded-xl border-2 bg-panel/70 transition-opacity",
          selected ? "border-accent" : "border-line",
          dim && "opacity-35",
          ring,
        )}
        style={{ borderTopColor: k.color }}
      >
        <NodeResizer isVisible={selected} minWidth={260} minHeight={150} lineClassName="!border-accent" handleClassName="!bg-accent" />
        <Handle type="target" position={Position.Left} />
        <div className="flex items-start gap-2 border-b border-line/70 px-3 py-2">
          <span style={{ color: k.color }}>{k.icon}</span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold">{n.name}</span>
              <span className={clsx("text-[10px] uppercase", STATUS_STYLE[n.status])}>{n.status}</span>
              {stale}
            </div>
            {n.summary && <div className="truncate text-[11px] text-muted">{n.summary}</div>}
          </div>
          {data.collapsed && (data.hiddenCount ?? 0) > 0 && (
            <span className="chip bg-bg text-muted" title={`${data.hiddenCount} hidden module(s) — click ▸ to expand`}>
              +{data.hiddenCount} modules
            </span>
          )}
          {tickets > 0 && <span className="chip bg-bg text-muted">{tickets} 🎫</span>}
          {data.onToggleCollapse && (
            <button
              className="nodrag rounded px-1 text-[11px] text-muted hover:bg-panel-2 hover:text-fg"
              title={data.collapsed ? "Expand" : "Collapse"}
              onClick={(e) => (e.stopPropagation(), data.onToggleCollapse!(n.id))}
            >
              {data.collapsed ? "▸" : "▾"}
            </button>
          )}
          <button
            className="nodrag rounded px-1 text-[11px] text-muted hover:bg-panel-2 hover:text-fg"
            title="Drill in"
            onClick={(e) => (e.stopPropagation(), data.onFocus(n.id))}
          >
            ⤢
          </button>
        </div>
        <Handle type="source" position={Position.Right} />
      </div>
    );
  }

  const concept = n.layer === "concept";
  return (
    <div
      className={clsx(
        "border bg-panel-2 px-3 py-2 shadow-sm transition-opacity",
        concept ? "rounded-2xl" : "rounded-lg",
        selected ? "border-accent" : "border-line",
        dim && "opacity-35",
        ring,
      )}
      style={{ width: concept ? LEAF_W + 20 : LEAF_W, minHeight: LEAF_H, borderLeft: concept ? undefined : `3px solid ${k.color}`, borderTop: concept ? `3px solid ${k.color}` : undefined }}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-1.5">
        <span className="text-xs" style={{ color: k.color }}>{k.icon}</span>
        <span className={clsx("truncate text-[13px] font-medium", n.layer === "code" && "font-mono text-[12px]")}>{n.name}</span>
        {tickets > 0 && <span className="ml-auto text-[10px] text-muted">{tickets}🎫</span>}
      </div>
      {n.summary && <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted">{n.summary}</div>}
      <div className="mt-1 flex items-center gap-1.5">
        <span className={clsx("text-[9px] uppercase", STATUS_STYLE[n.status])}>{n.kind} · {n.status}</span>
        {stale}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

/**
 * ERD card for the data layer: one row per column, with per-column handles for FK edges.
 * Reads like the sentence "one project has many tickets": parents sit left, children right.
 * A relationship line leaves the child's FK column on its LEFT edge and enters the
 * parent's referenced column on its RIGHT edge (so drag from a child's left dot to a parent's right dot).
 */
const TableNode = memo(function TableNode({ data, selected }: NodeProps<Node<NodeData>>) {
  const { n, dim } = data;
  const cols = n.columns as Column[];
  const k = KIND_STYLE[n.kind] ?? KIND_STYLE.table;
  const isEnum = n.kind === "enum";
  return (
    <div
      className={clsx("rounded-lg border bg-panel-2 shadow-sm transition-opacity", selected ? "border-accent" : "border-line", dim && "opacity-35", ringClass(data))}
      style={{ width: TABLE_W, borderTop: `3px solid ${k.color}` }}
    >
      <Handle type="target" position={Position.Right} id="node-in" className="erd-handle" style={{ top: TABLE_HEADER_H / 2 }} />
      <Handle type="source" position={Position.Left} id="node-out" className="erd-handle" style={{ top: TABLE_HEADER_H / 2 }} />
      <div className="flex items-center gap-2 border-b border-line px-3" style={{ height: TABLE_HEADER_H - 3 }}>
        <span className="text-xs" style={{ color: k.color }}>{k.icon}</span>
        <span className="truncate font-mono text-[13px] font-semibold">{n.name}</span>
        {n.kind !== "table" && <span className="chip bg-bg text-[9px] uppercase text-muted">{n.kind}</span>}
        {n.stale && <span className="chip bg-warn/15 text-[9px] text-warn" title={n.staleReason ?? "Schema changed"}>⚠ stale</span>}
        {data.flux && <FluxBadge flux={data.flux} />}
      </div>
      <div className="py-1">
        {cols.length === 0 && (
          <div className="px-3 text-[11px] italic text-muted" style={{ height: TABLE_ROW_H, lineHeight: `${TABLE_ROW_H}px` }}>
            no columns mapped
          </div>
        )}
        {cols.map((c) => {
          const on = data.hlCols?.has(c.name);
          const flag = c.pk ? "PK" : c.references ? "FK" : c.unique ? "UQ" : "";
          return (
            <div
              key={c.name}
              className={clsx("relative flex cursor-pointer items-center gap-1.5 px-3 font-mono text-[11.5px] hover:bg-panel", on && "!bg-accent/15")}
              style={{ height: TABLE_ROW_H }}
              title={[c.note, c.references && `→ ${c.references}${c.onDelete ? ` (on delete ${c.onDelete})` : ""}`, c.default && `default ${c.default}`].filter(Boolean).join(" · ") || undefined}
              onClick={(e) => {
                e.stopPropagation();
                data.onColumnClick?.(n.id, c.name);
              }}
            >
              <Handle type="target" position={Position.Right} id={`in-${c.name}`} className="erd-handle" />
              <span className={clsx("w-5 shrink-0 text-[9px] font-semibold", c.pk ? "text-accent" : "text-muted")}>{flag}</span>
              <span className={clsx("truncate", c.pk && "font-semibold")}>{c.name}</span>
              {!isEnum && (
                <span className="ml-auto truncate pl-2 text-[11px] text-muted">
                  {c.type}
                  {c.nullable ? "?" : ""}
                </span>
              )}
              <Handle type="source" position={Position.Left} id={`out-${c.name}`} className="erd-handle" />
            </div>
          );
        })}
      </div>
    </div>
  );
});

function FluxBadge({ flux }: { flux: NonNullable<NodeData["flux"]> }) {
  return (
    <span
      className="chip bg-agent/15 text-[9px] text-agent"
      title={`Being changed by ${flux.by}${flux.ticket ? ` (${flux.ticket})` : ""}; not landed yet${flux.drafts ? ` · ${flux.drafts} pending map update(s)` : ""}`}
    >
      ✎ in flux
    </span>
  );
}

/** Crow's-foot cardinality markers (normal + highlighted). */
function ErdMarkers() {
  const set = (suffix: string, color: string) => (
    <>
      <marker id={`wh-many${suffix}`} viewBox="0 0 16 16" markerWidth="16" markerHeight="16" refX="15" refY="8" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
        <path d="M3,8 L15,2 M3,8 L15,14 M1,8 L15,8" fill="none" style={{ stroke: color }} strokeWidth="1.4" />
      </marker>
      <marker id={`wh-one${suffix}`} viewBox="0 0 16 16" markerWidth="16" markerHeight="16" refX="15" refY="8" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
        <path d="M9,2 L9,14 M1,8 L15,8" fill="none" style={{ stroke: color }} strokeWidth="1.4" />
      </marker>
    </>
  );
  return (
    <svg style={{ position: "absolute", width: 0, height: 0 }} aria-hidden>
      <defs>
        {set("", "var(--flow-edge)")}
        {set("-hl", "var(--accent)")}
      </defs>
    </svg>
  );
}

const nodeTypes = { box: BoxNode, table: TableNode };

function depthOf(id: string, byId: Map<string, GNode>) {
  let d = 0;
  let cur = byId.get(id);
  while (cur?.parentId && d < 20) {
    cur = byId.get(cur.parentId);
    d++;
  }
  return d;
}

/** Header-only size for a collapsed container (WH-22: "shrinks to its header"). */
const COLLAPSED_SIZE = { w: 240, h: 44 };

/** Size a group to fit its children unless the user has resized it. */
function groupSize(n: GNode, children: GNode[], sizes: Map<string, { w: number; h: number }>) {
  if (n.width && n.height) return { w: n.width, h: n.height };
  let w = 280;
  let h = 150;
  for (const c of children) {
    const s = sizes.get(c.id) ?? { w: LEAF_W + 20, h: LEAF_H + 24 };
    w = Math.max(w, c.x + s.w + 24);
    h = Math.max(h, c.y + s.h + 24);
  }
  return { w, h };
}

type Highlight = {
  related: Set<string> | null;
  current: string | null;
  visited: Set<string>;
  stepEdge: [string, string] | null;
  cols: Set<string>; // "nodeId:column" highlighted on the data layer
};

function toFlow(
  g: Graph,
  lens: LayerId,
  focusId: string | null,
  hl: Highlight,
  onFocus: (id: string) => void,
  onColumnClick: (nodeId: string, column: string) => void,
  collapsedIds: Set<string>,
  onToggleCollapse: (id: string) => void,
) {
  const erd = lens === "data";
  // The data layer is flat (an ERD), so ignore nesting there.
  const layerNodes = g.nodes.filter((n) => n.layer === lens).map((n) => (erd ? { ...n, parentId: null } : n));
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const visible = focusId && byId.get(focusId)?.layer === lens ? subtree(focusId, layerNodes) : new Set(layerNodes.map((n) => n.id));
  const kids = new Map<string, GNode[]>();
  for (const n of layerNodes) if (n.parentId) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);
  const ticketCount = new Map<string, number>();
  for (const l of g.ticketLinks) ticketCount.set(l.nodeId, (ticketCount.get(l.nodeId) ?? 0) + 1);

  // WH-22: collapsed containers hide their whole subtree (but never the focus-drill root itself).
  const collapsedActive = !erd ? [...collapsedIds].filter((id) => id !== focusId && visible.has(id)) : [];
  const hiddenByCollapse = new Set<string>();
  for (const cid of collapsedActive) for (const x of subtree(cid, layerNodes)) if (x !== cid) hiddenByCollapse.add(x);
  // Nearest visible ancestor of a (possibly hidden) node — itself if already visible.
  const nearestVisible = (id: string): string => {
    let cur: string | undefined = id;
    while (cur && hiddenByCollapse.has(cur)) cur = byId.get(cur)?.parentId ?? undefined;
    return cur ?? id;
  };

  // Deepest first so group sizes can include their children's sizes.
  const ordered = layerNodes.filter((n) => visible.has(n.id) && !hiddenByCollapse.has(n.id)).sort((a, b) => depthOf(b.id, byId) - depthOf(a.id, byId));
  const sizes = new Map<string, { w: number; h: number }>();
  for (const n of ordered) {
    if (collapsedActive.includes(n.id)) {
      sizes.set(n.id, n.width && n.height ? { w: n.width, h: n.height } : COLLAPSED_SIZE);
      continue;
    }
    const c = (kids.get(n.id) ?? []).filter((x) => visible.has(x.id) && !hiddenByCollapse.has(x.id));
    if (c.length) sizes.set(n.id, groupSize(n, c, sizes));
  }
  // A group counts as related if anything inside it is.
  const relatedOrHasRelated = (id: string) => {
    if (!hl.related) return false;
    for (const x of subtree(id, layerNodes)) if (hl.related.has(x)) return true;
    return false;
  };

  // Count hidden descendant nodes per collapsed container, for the "+N modules" label.
  const hiddenCountOf = (id: string) => {
    let n = 0;
    for (const x of subtree(id, layerNodes)) if (x !== id && hiddenByCollapse.has(x)) n++;
    return n;
  };

  const nodes: Node<NodeData>[] = [...ordered].reverse().map((n) => {
    const allKids = kids.get(n.id) ?? [];
    const hasChildren = allKids.some((x) => visible.has(x.id));
    const collapsed = collapsedActive.includes(n.id);
    const parentVisible = n.parentId && visible.has(n.parentId) && !hiddenByCollapse.has(n.parentId) && n.id !== focusId;
    const s = sizes.get(n.id);
    const related = !!hl.related?.has(n.id);
    return {
      id: n.id,
      type: erd ? "table" : "box",
      position: { x: n.x, y: n.y },
      ...(parentVisible ? { parentId: n.parentId!, extent: "parent" as const } : {}),
      ...(hasChildren ? { style: { width: s!.w, height: s!.h }, zIndex: 0 } : { zIndex: 1 }),
      data: {
        n,
        hasChildren,
        tickets: ticketCount.get(n.id) ?? 0,
        dim: !!hl.related && !relatedOrHasRelated(n.id),
        related,
        flowCurrent: hl.current === n.id,
        flowVisited: hl.visited.has(n.id),
        onFocus,
        flux: g.flux[n.id]
          ? {
              by: g.flux[n.id].sessions[0]?.by ?? g.flux[n.id].drafts[0]?.authorName ?? "someone",
              ticket: g.flux[n.id].sessions[0]?.ticket ?? null,
              drafts: g.flux[n.id].drafts.length,
            }
          : null,
        ...(erd
          ? {
              hlCols: new Set(n.columns.map((c) => c.name).filter((c) => hl.cols.has(`${n.id}:${c}`))),
              onColumnClick,
            }
          : {
              ...(hasChildren || collapsed ? { collapsed, hiddenCount: hiddenCountOf(n.id), onToggleCollapse } : {}),
            }),
      },
    };
  });
  const hasCol = (id: string, col?: string) => !!col && !!byId.get(id)?.columns.some((c) => c.name === col);

  // WH-22: edges touching a hidden node are re-pointed to its nearest visible (collapsed) ancestor,
  // and duplicates created by that remap are merged into one edge carrying a "×N" count.
  const liveEdges = g.edges.filter(
    (e) => (e.kind === "depends" || (erd && e.kind === "references")) && visible.has(e.fromNodeId) && visible.has(e.toNodeId),
  );
  const remapped = erd ? liveEdges : remapCollapsedEdges(liveEdges, nearestVisible);

  const stepKey = hl.stepEdge ? `${hl.stepEdge[0]}>${hl.stepEdge[1]}` : null;
  const edges: Edge[] = remapped
    .map((e): Edge => {
      if (e.kind === "references") {
        const m = e.meta ?? {};
        const card = m.cardinality ?? "n-1";
        const lit = (m.fromColumn && hl.cols.has(`${e.fromNodeId}:${m.fromColumn}`)) || (m.toColumn && hl.cols.has(`${e.toNodeId}:${m.toColumn}`));
        const sfx = lit ? "-hl" : "";
        return {
          id: e.id,
          source: e.fromNodeId,
          target: e.toNodeId,
          sourceHandle: hasCol(e.fromNodeId, m.fromColumn) ? `out-${m.fromColumn}` : "node-out",
          targetHandle: hasCol(e.toNodeId, m.toColumn) ? `in-${m.toColumn}` : "node-in",
          type: "default",
          zIndex: lit ? 4 : 2,
          markerStart: (card === "n-1" || card === "n-m" ? "wh-many" : "wh-one") + sfx,
          markerEnd: (card === "1-n" || card === "n-m" ? "wh-many" : "wh-one") + sfx,
          style: { stroke: lit ? "var(--accent)" : "var(--flow-edge)", strokeWidth: lit ? 2 : 1.2, opacity: hl.related && !lit ? 0.35 : 1 },
          data: { erd: true },
        };
      }
      const active = stepKey === `${e.fromNodeId}>${e.toNodeId}` || stepKey === `${e.toNodeId}>${e.fromNodeId}`;
      return {
        id: e.id,
        source: e.fromNodeId,
        target: e.toNodeId,
        ...(erd ? { sourceHandle: "node-out", targetHandle: "node-in" } : {}),
        label: e.label || undefined,
        type: "default",
        zIndex: 2,
        animated: active,
        markerEnd: { type: MarkerType.ArrowClosed, color: active ? "var(--accent)" : "var(--flow-edge)" },
        style: { stroke: active ? "var(--accent)" : "var(--flow-edge)", strokeWidth: active ? 2.5 : 1, opacity: hl.related ? 0.35 : 1 },
        labelStyle: { fill: "var(--fg)", fontSize: 11 },
        labelBgStyle: { fill: "var(--panel)" },
      };
    });
  // Flow step between nodes with no real edge: draw a temporary one so the path reads.
  if (hl.stepEdge && !edges.some((e) => e.animated) && visible.has(hl.stepEdge[0]) && visible.has(hl.stepEdge[1]) && hl.stepEdge[0] !== hl.stepEdge[1]) {
    edges.push({
      id: "flow-step",
      source: hl.stepEdge[0],
      target: hl.stepEdge[1],
      ...(erd ? { sourceHandle: "node-out", targetHandle: "node-in" } : {}),
      type: "default",
      animated: true,
      zIndex: 3,
      markerEnd: { type: MarkerType.ArrowClosed, color: "var(--accent)" },
      style: { stroke: "var(--accent)", strokeWidth: 2.5, strokeDasharray: "6 4" },
    });
  }
  return { nodes, edges };
}

// ───────── main ─────────

export function KnowledgeMap(props: { projectKey: string; initial: Graph; askEnabled: boolean; initialNode?: string; initialFlow?: string; initialLens?: string }) {
  return (
    <ReactFlowProvider>
      <GlossaryProvider terms={props.initial.terms}>
        <MapInner {...props} />
      </GlossaryProvider>
    </ReactFlowProvider>
  );
}

function pickLens(g: Graph, wanted?: string): LayerId {
  if (wanted && LAYER_ORDER.includes(wanted as LayerId)) return wanted as LayerId;
  if (g.nodes.some((n) => n.layer === "system")) return "system";
  return LAYER_ORDER.find((l) => g.nodes.some((n) => n.layer === l)) ?? "system";
}

function MapInner({ projectKey, initial, askEnabled, initialNode, initialFlow, initialLens }: { projectKey: string; initial: Graph; askEnabled: boolean; initialNode?: string; initialFlow?: string; initialLens?: string }) {
  const router = useRouter();
  const [graph, setGraph] = useState<Graph>(initial);
  const initialNodeRow = initialNode ? initial.nodes.find((n) => n.id === initialNode) : undefined;
  const [lens, setLens] = useState<LayerId>(() => (initialNodeRow?.layer as LayerId) ?? pickLens(initial, initialLens));
  const [focusId, setFocusId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initialNodeRow?.id ?? null);
  const [staleOnly, setStaleOnly] = useState(false);
  const [flowsOpen, setFlowsOpen] = useState(!!initialFlow);
  const [play, setPlay] = useState<{ flowId: string; step: number } | null>(() => {
    const f = initialFlow ? initial.flows.find((x) => x.id === initialFlow || x.name === initialFlow) : undefined;
    return f && f.steps.length ? { flowId: f.id, step: 0 } : null;
  });
  const [askOpen, setAskOpen] = useState(false);
  const [askFocus, setAskFocus] = useState<GNode | null>(null);
  const [editor, setEditor] = useState<FlowDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ text: string; revert: () => void } | null>(null);
  const [colHl, setColHl] = useState<{ nodeId: string; column: string } | null>(null);
  const [, start] = useTransition();
  const busy = useRef(false);
  const rf = useReactFlow();
  const theme = useResolvedTheme();
  const { confirm, prompt, dialogs } = useDialogs();

  // WH-22: collapse state per lens, persisted per browser (localStorage), following the
  // loadView/saveView pattern. Containers are collapsed by default until a person toggles one.
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (lens === "data") {
      setCollapsedIds(new Set());
      return;
    }
    setCollapsedIds(loadCollapsed(collapseKey(projectKey, lens)));
  }, [projectKey, lens]);
  const toggleCollapse = useCallback(
    (id: string) => {
      setCollapsedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        saveCollapsed(collapseKey(projectKey, lens), next);
        const seen = loadCollapsed(seenKey(projectKey, lens));
        seen.add(id);
        saveCollapsed(seenKey(projectKey, lens), seen);
        return next;
      });
      // WH-22: collapsing/expanding changes the lens's footprint (shrinks to a header, or
      // regrows) — re-run the lens's auto-layout so siblings reflow instead of leaving dead
      // space or new overlaps. Only re-places nodes nobody has manually dragged (onlyUnplaced
      // would be too narrow here since a collapse genuinely changes everyone's neighbors, so
      // this intentionally passes `false`, same as a manual Tidy click).
      setTimeout(() => runAutoLayoutRef.current?.(lens, layoutDirRef.current, false), 140);
    },
    [projectKey, lens],
  );
  // Containers nobody has touched yet default to collapsed; mark them collapsed once per id
  // the first time they're seen in this lens (new node created after a prior visit, etc).
  const defaultedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (lens === "data") return;
    const kidsOf = new Set(graph.nodes.filter((n) => n.layer === lens && n.parentId).map((n) => n.parentId!));
    const seen = loadCollapsed(seenKey(projectKey, lens));
    const toAdd = [...kidsOf].filter((id) => !seen.has(id) && !defaultedRef.current.has(id));
    if (!toAdd.length) return;
    for (const id of toAdd) defaultedRef.current.add(id);
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      for (const id of toAdd) next.add(id);
      saveCollapsed(collapseKey(projectKey, lens), next);
      const seen2 = loadCollapsed(seenKey(projectKey, lens));
      for (const id of toAdd) seen2.add(id);
      saveCollapsed(seenKey(projectKey, lens), seen2);
      return next;
    });
  }, [graph.nodes, lens, projectKey]);

  const [layoutDir, setLayoutDir] = useState<Direction>("LR");
  const [laying, setLaying] = useState(false);
  // Refs so toggleCollapse (defined above runAutoLayout) can trigger a re-layout without a
  // declaration-order dependency cycle.
  const layoutDirRef = useRef(layoutDir);
  useEffect(() => void (layoutDirRef.current = layoutDir), [layoutDir]);
  const runAutoLayoutRef = useRef<((targetLens: LayerId, dir: Direction, onlyUnplaced: boolean) => Promise<void>) | null>(null);

  const reload = useCallback(async () => {
    if (busy.current) return;
    const res = await getGraphAction(projectKey);
    if (res.ok) setGraph(JSON.parse(JSON.stringify(res.data)));
  }, [projectKey]);

  useEffect(() => {
    const on = () => reload();
    window.addEventListener("wheelhouse:changed", on);
    return () => window.removeEventListener("wheelhouse:changed", on);
  }, [reload]);

  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);
  const selected = selectedId ? byId.get(selectedId) : undefined;
  const activeFlow = play ? graph.flows.find((f) => f.id === play.flowId) : undefined;
  const step = activeFlow?.steps[play!.step];

  // Keep the URL shareable without triggering a server re-render.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    sp.set("lens", lens);
    if (selectedId) sp.set("node", selectedId);
    else sp.delete("node");
    if (activeFlow) sp.set("flow", activeFlow.id);
    else sp.delete("flow");
    window.history.replaceState(null, "", `?${sp.toString()}`);
  }, [lens, selectedId, activeFlow]);

  // Flow playback drives lens, drill-down and selection.
  useEffect(() => {
    if (!step) return;
    const n = byId.get(step.nodeId);
    if (!n) return;
    setLens(n.layer as LayerId);
    setSelectedId(n.id);
    setFocusId((f) => (f && !subtree(f, graph.nodes).has(n.id) ? null : f));
    const t = setTimeout(() => rf.fitView({ nodes: [{ id: n.id }], padding: 0.8, maxZoom: 1.1, duration: 450 }), 80);
    return () => clearTimeout(t);
  }, [step, byId, graph.nodes, rf]);

  const highlight: Highlight = useMemo(() => {
    const visited = new Set<string>();
    let stepEdge: [string, string] | null = null;
    if (activeFlow && play) {
      for (let i = 0; i < play.step; i++) visited.add(activeFlow.steps[i].nodeId);
      if (play.step > 0) stepEdge = [activeFlow.steps[play.step - 1].nodeId, activeFlow.steps[play.step].nodeId];
    }
    let related: Set<string> | null = null;
    if (staleOnly) related = new Set(graph.nodes.filter((n) => n.stale && n.layer === lens).map((n) => n.id));
    else if (!activeFlow && selected && selected.layer !== lens) related = relatedOnLayer(selected.id, lens, graph.nodes, graph.edges);
    else if (!activeFlow && colHl && lens === "data") {
      // Dim tables not involved in the clicked column's relationships.
      related = new Set([colHl.nodeId]);
      for (const e of graph.edges)
        if (e.kind === "references" && ((e.fromNodeId === colHl.nodeId && e.meta?.fromColumn === colHl.column) || (e.toNodeId === colHl.nodeId && e.meta?.toColumn === colHl.column)))
          related.add(e.fromNodeId === colHl.nodeId ? e.toNodeId : e.fromNodeId);
      if (related.size === 1) related = null;
    }
    // Clicked column: light it and every column it's linked to by a foreign key.
    const cols = new Set<string>();
    if (colHl && lens === "data") {
      cols.add(`${colHl.nodeId}:${colHl.column}`);
      for (const e of graph.edges) {
        if (e.kind !== "references") continue;
        if (e.fromNodeId === colHl.nodeId && e.meta?.fromColumn === colHl.column && e.meta.toColumn) cols.add(`${e.toNodeId}:${e.meta.toColumn}`);
        if (e.toNodeId === colHl.nodeId && e.meta?.toColumn === colHl.column && e.meta.fromColumn) cols.add(`${e.fromNodeId}:${e.meta.fromColumn}`);
      }
    }
    return { related, current: step?.nodeId ?? null, visited, stepEdge, cols };
  }, [activeFlow, play, staleOnly, selected, lens, graph.nodes, graph.edges, step, colHl]);

  const onColumnClick = useCallback((nodeId: string, column: string) => {
    setSelectedId(nodeId);
    setSelectedEdgeId(null);
    setColHl((c) => (c && c.nodeId === nodeId && c.column === column ? null : { nodeId, column }));
  }, []);
  const flow = useMemo(
    () => toFlow(graph, lens, focusId, highlight, setFocusId, onColumnClick, collapsedIds, toggleCollapse),
    [graph, lens, focusId, highlight, onColumnClick, collapsedIds, toggleCollapse],
  );
  const [nodes, setNodes] = useState(flow.nodes);
  useEffect(() => setNodes(flow.nodes.map((n) => ({ ...n, selected: n.id === selectedId }))), [flow.nodes, selectedId]);
  useEffect(() => {
    if (play) return; // playback does its own framing
    const t = setTimeout(() => rf.fitView({ padding: 0.15, duration: 300 }), 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, lens, rf]);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      busy.current = true;
      const res = await fn();
      busy.current = false;
      if (!res.ok) setError(res.error ?? "Failed");
      await reload();
    });

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<NodeData>>[]) => {
      setNodes((ns) => applyNodeChanges(changes, ns));
      const resized = changes.filter((c) => c.type === "dimensions" && c.resizing === false && c.dimensions);
      if (resized.length) {
        saveLayoutAction(
          projectKey,
          resized.map((c) => {
            const n = graph.nodes.find((x) => x.id === (c as { id: string }).id)!;
            const d = (c as { dimensions: { width: number; height: number } }).dimensions;
            return { id: n.id, x: n.x, y: n.y, width: d.width, height: d.height };
          }),
        ).then(reload);
      }
    },
    [projectKey, graph.nodes, reload],
  );

  const onNodeDragStart = () => (busy.current = true);
  /**
   * WH-23: after a drag, warn (non-blocking) if the node now sits to the left of something that
   * points into it — the layout's left-to-right reading order would be broken. We warn rather than
   * snap: snapping a manual drag back would be surprising and silently overrides the person's intent,
   * which cuts against this app's general "never block/override manual work" UX (see the undo-toast
   * pattern for connections, and the non-blocking `error` banner elsewhere in this component).
   */
  const checkLeftToRight = useCallback(
    (positions: { id: string; x: number }[]) => {
      if (lens === "data") return; // ERD has its own established child-left/parent-right convention
      const edgeKind = "depends";
      const xOf = (id: string) => positions.find((p) => p.id === id)?.x ?? byId.get(id)?.x;
      const widthOf = (id: string) => byId.get(id)?.width ?? LEAF_W;
      for (const p of positions) {
        const incoming = graph.edges.filter((e) => e.kind === edgeKind && e.toNodeId === p.id).map((e) => e.fromNodeId);
        if (!incoming.length) continue;
        const { violates } = violatesLeftToRight(p.id, p.x, widthOf, incoming, xOf);
        if (violates) {
          const n = byId.get(p.id);
          setError(`"${n?.name ?? "This node"}" is now left of something that depends on it — the left-to-right reading order is broken. Use Tidy to re-arrange.`);
          return;
        }
      }
    },
    [lens, graph.edges, byId],
  );
  const onNodeDragStop = (_: unknown, __: Node, dragged: Node[]) => {
    const positions = dragged.map((d) => ({ id: d.id, x: Math.round(d.position.x), y: Math.round(d.position.y) }));
    saveLayoutAction(projectKey, positions).then(() => {
      busy.current = false;
      setGraph((g) => ({
        ...g,
        nodes: g.nodes.map((n) => {
          const p = positions.find((x) => x.id === n.id);
          return p ? { ...n, x: p.x, y: p.y } : n;
        }),
      }));
      checkLeftToRight(positions);
    });
  };

  /** Set (or clear) a column's foreign key; the references edge is derived from it server-side. */
  const setColumnReference = useCallback(
    (tableId: string, column: string, target: string | undefined) => {
      const t = graph.nodes.find((n) => n.id === tableId);
      if (!t) return;
      const columns = t.columns.map((c) => {
        if (c.name !== column) return c;
        const { references: _r, onDelete: _o, ...rest } = c;
        void _r;
        void _o;
        return target ? { ...rest, references: target } : rest;
      });
      run(() => upsertNodeAction(projectKey, { id: tableId, columns }));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph.nodes, projectKey],
  );

  const onConnect = (c: Connection) => {
    if (!c.source || !c.target || c.source === c.target) return;
    if (lens === "data") {
      // ERD: drag from a child column (left dot) to a parent column (right dot) = add a foreign key.
      const fromCol = c.sourceHandle?.startsWith("out-") ? c.sourceHandle.slice(4) : null;
      const toCol = c.targetHandle?.startsWith("in-") ? c.targetHandle.slice(3) : null;
      const from = byId.get(c.source);
      const to = byId.get(c.target);
      if (!fromCol || !toCol || !from || !to) {
        setError("Drag from a column on one table to a column on another to add a foreign key");
        return;
      }
      const prev = from.columns.find((x) => x.name === fromCol)?.references;
      setColumnReference(from.id, fromCol, `${to.name}.${toCol}`);
      setUndo({ text: `${from.name}.${fromCol} → ${to.name}.${toCol}`, revert: () => setColumnReference(from.id, fromCol, prev) });
      return;
    }
    const existed = graph.edges.some((e) => e.kind === "depends" && e.fromNodeId === c.source && e.toNodeId === c.target);
    run(async () => {
      const res = await connectNodesAction(projectKey, c.source!, c.target!);
      // Offer an undo for brand-new connections (accidental drags are easy on a canvas).
      if (res.ok && !existed) {
        const edgeId = res.data.id;
        setUndo({ text: `Connected ${byId.get(c.source!)?.name ?? "?"} → ${byId.get(c.target!)?.name ?? "?"}`, revert: () => removeEdge(edgeId) });
      }
      return res;
    });
  };
  const removeEdge = useCallback(
    (edgeId: string) => {
      setSelectedEdgeId((id) => (id === edgeId ? null : id));
      setUndo(null);
      const e = graph.edges.find((x) => x.id === edgeId);
      // Optimistic: drop it locally so the canvas updates immediately.
      setGraph((g) => ({ ...g, edges: g.edges.filter((x) => x.id !== edgeId) }));
      // FK edges are derived from the column definition, so clear the column instead.
      if (e?.kind === "references" && e.meta?.derived && e.meta.fromColumn) setColumnReference(e.fromNodeId, e.meta.fromColumn, undefined);
      else run(() => deleteEdgeAction(projectKey, edgeId));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectKey, graph.edges, setColumnReference],
  );
  const onEdgesDelete = (es: Edge[]) => es.filter((e) => e.id !== "flow-step").forEach((e) => removeEdge(e.id));

  // Undo toast: auto-dismiss, and Cmd/Ctrl+Z undoes the last connection while it's showing.
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 8000);
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !(e.target as HTMLElement)?.closest("input,textarea,[contenteditable]")) {
        e.preventDefault();
        undo.revert();
        setUndo(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [undo]);

  /** Auto-arrange the data layer left→right along foreign keys. */
  const tidyLayout = () => {
    const tables = graph.nodes.filter((n) => n.layer === "data");
    if (!tables.length) return;
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "RL", nodesep: 40, ranksep: 140, marginx: 40, marginy: 40 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const t of tables) g.setNode(t.id, { width: TABLE_W, height: tableHeight(t.columns.length) });
    for (const e of graph.edges) if (e.kind === "references" && g.hasNode(e.fromNodeId) && g.hasNode(e.toNodeId)) g.setEdge(e.fromNodeId, e.toNodeId);
    dagre.layout(g);
    const positions = tables.map((t) => {
      const p = g.node(t.id);
      return { id: t.id, x: Math.round(p.x - TABLE_W / 2), y: Math.round(p.y - p.height / 2) };
    });
    setGraph((gr) => ({ ...gr, nodes: gr.nodes.map((n) => ({ ...n, ...(positions.find((p) => p.id === n.id) ?? {}) })) }));
    saveLayoutAction(projectKey, positions, { placed: false });
    setTimeout(() => rf.fitView({ padding: 0.12, duration: 400 }), 60);
  };

  /**
   * WH-21/WH-23: measured size for a node on the current lens — prefer React Flow's own
   * post-render `measured` dimensions (real rendered size), then a manually resized
   * `width`/`height`, then a sane per-kind default. Used as layout-engine input so dagre/ELK
   * place boxes by their real footprint, not an estimate.
   */
  const measuredSize = useCallback(
    (n: GNode, hasKids: boolean) => {
      const live = nodes.find((x) => x.id === n.id) as (Node<NodeData> & { measured?: { width?: number; height?: number } }) | undefined;
      const mw = live?.measured?.width ?? (typeof live?.style?.width === "number" ? live.style.width : undefined);
      const mh = live?.measured?.height ?? (typeof live?.style?.height === "number" ? live.style.height : undefined);
      if (mw && mh) return { w: mw, h: mh };
      if (n.width && n.height) return { w: n.width, h: n.height };
      if (hasKids) return { w: 280, h: 150 };
      return n.layer === "concept" ? { w: LEAF_W + 20, h: LEAF_H } : { w: LEAF_W, h: LEAF_H };
    },
    [nodes],
  );

  /**
   * WH-21: auto-layout dispatcher for every lens other than Data (which keeps its own
   * FK-driven `tidyLayout` above, deliberately using rankdir "RL" so FK arrows read
   * child-left → parent-right per the ERD's established convention — see that function's
   * doc comment; changing it would flip the crow's-foot drag-to-connect direction).
   *
   * `onlyUnplaced`: when true (an automatic pass on load), only nodes that have never been
   * explicitly positioned (`placed === false`, the server-side flag set by saveLayout/upsertNode)
   * are moved; a manual "Tidy" click passes false and rearranges everything in the lens, since
   * that's an explicit, visible, user-triggered action (mirrors `saveLayout`'s own `placed` opt).
   */
  const runAutoLayout = useCallback(
    async (targetLens: LayerId, dir: Direction, onlyUnplaced: boolean) => {
      if (targetLens === "data") return; // data lens uses its own FK-oriented tidyLayout
      const all = graph.nodes.filter((n) => n.layer === targetLens);
      if (!all.length) return;
      const kids = new Map<string, GNode[]>();
      for (const n of all) if (n.parentId) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);
      const targets = onlyUnplaced ? all.filter((n) => !n.placed) : all;
      if (!targets.length) return;
      const targetIds = new Set(targets.map((n) => n.id));

      const layoutNodes = all.map((n) => {
        const s = measuredSize(n, (kids.get(n.id) ?? []).length > 0);
        return { id: n.id, width: s.w, height: s.h, parentId: n.parentId };
      });
      // WH-23: break cycles in the `depends` graph before ranking, so a layered layout still
      // gets a valid left-to-right order; the back-edge found last in DFS is treated as the
      // "weakest" one (simplest proxy available — the schema has no edge-weight/recency field
      // exposed to the client, and "most recently traversed back-edge" approximates "most
      // tangential to the main dependency chain" well enough for ranking purposes). The edge
      // still renders in its real direction — only the rank-assignment input is flipped.
      const dependsEdges = graph.edges.filter((e) => e.kind === "depends" && targetIds.has(e.fromNodeId) === targetIds.has(e.toNodeId) && all.some((n) => n.id === e.fromNodeId) && all.some((n) => n.id === e.toNodeId));
      const acyclicEdges = breakCycles(
        all.map((n) => n.id),
        dependsEdges.map((e) => ({ source: e.fromNodeId, target: e.toNodeId })),
      );

      setLaying(true);
      try {
        const result =
          targetLens === "system"
            ? await elkLayout(layoutNodes, acyclicEdges, dir)
            : targetLens === "code"
              ? treeLayout(layoutNodes, acyclicEdges, dir)
              : dagreLayout(layoutNodes, acyclicEdges, dir);

        const positions = targets
          .map((n) => {
            const p = result.get(n.id);
            return p ? { id: n.id, x: Math.round(p.x), y: Math.round(p.y) } : null;
          })
          .filter((p): p is { id: string; x: number; y: number } => !!p);
        if (!positions.length) return;
        setGraph((gr) => ({ ...gr, nodes: gr.nodes.map((n) => ({ ...n, ...(positions.find((p) => p.id === n.id) ?? {}) })) }));
        await saveLayoutAction(projectKey, positions, { placed: onlyUnplaced ? true : false });
        setTimeout(() => rf.fitView({ padding: 0.12, duration: 400 }), 60);
      } finally {
        setLaying(false);
      }
    },
    [graph.nodes, graph.edges, measuredSize, projectKey, rf],
  );
  useEffect(() => void (runAutoLayoutRef.current = runAutoLayout), [runAutoLayout]);

  // WH-21: on load (and whenever the lens's node set changes), auto-place any node that was
  // never explicitly positioned (fresh agent-created nodes land with placed=false server-side).
  // Dragged/tidied nodes have placed=true and are left exactly where they are.
  const autoLaidRef = useRef<string | null>(null);
  useEffect(() => {
    if (lens === "data") return;
    const unplaced = graph.nodes.filter((n) => n.layer === lens && !n.placed);
    if (!unplaced.length) return;
    const key = `${lens}:${unplaced.map((n) => n.id).sort().join(",")}`;
    if (autoLaidRef.current === key) return;
    autoLaidRef.current = key;
    // Let React Flow render + measure the freshly-synced nodes first.
    const t = setTimeout(() => runAutoLayout(lens, layoutDir, true), 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph.nodes, lens]);

  const selectedEdge = selectedEdgeId ? graph.edges.find((e) => e.id === selectedEdgeId) : undefined;
  const edges = useMemo(
    () =>
      flow.edges.map((e) =>
        e.id === selectedEdgeId
          ? e.data?.erd
            ? {
                ...e,
                selected: true,
                zIndex: 5,
                style: { ...e.style, stroke: "var(--accent)", strokeWidth: 2.5, opacity: 1 },
                markerStart: `${String(e.markerStart).replace("-hl", "")}-hl`,
                markerEnd: `${String(e.markerEnd).replace("-hl", "")}-hl`,
              }
            : { ...e, selected: true, style: { ...e.style, stroke: "var(--accent)", strokeWidth: 2.5, opacity: 1 }, markerEnd: { type: MarkerType.ArrowClosed, color: "var(--accent)" } }
          : { ...e, interactionWidth: 24 },
      ),
    [flow.edges, selectedEdgeId],
  );

  const crumbs: GNode[] = [];
  for (let cur = focusId ? byId.get(focusId) : undefined; cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) crumbs.unshift(cur);

  const selectNode = useCallback(
    (id: string) => {
      const n = byId.get(id);
      if (!n) return;
      setPlay(null);
      setStaleOnly(false);
      setLens(n.layer as LayerId);
      setFocusId((f) => (f && !subtree(f, graph.nodes).has(id) ? null : f));
      setSelectedId(id);
      setTimeout(() => rf.fitView({ nodes: [{ id }], padding: 0.8, maxZoom: 1.1, duration: 400 }), 80);
    },
    [byId, graph.nodes, rf],
  );

  /** In-app links from markdown/answers: #node:layer:Name, #adr:N */
  const onInternalLink = useCallback(
    (href: string) => {
      if (href.startsWith("#node:")) {
        const ref = decodeURIComponent(href.slice(6));
        const m = /^(concept|system|data|code):(.+)$/i.exec(ref);
        const name = (m ? m[2] : ref).trim().toLowerCase();
        const n = graph.nodes.find((x) => x.name.toLowerCase() === name && (!m || x.layer === m[1].toLowerCase()));
        if (n) selectNode(n.id);
        else setError(`"${ref}" isn't on the map`);
        return true;
      }
      if (href.startsWith("#adr:")) {
        router.push(`/p/${projectKey}/decisions#adr-${href.slice(5)}`);
        return true;
      }
      return false;
    },
    [graph.nodes, selectNode, router, projectKey],
  );

  const addNode = async (parentId: string | null) => {
    const parent = parentId ? byId.get(parentId) : undefined;
    const layer = (parent?.layer as LayerId) ?? lens;
    const noun = { concept: parent ? "capability" : "concept", system: parent ? "module" : "service", data: "table", code: parent ? "file" : "directory" }[layer];
    const name = await prompt({
      title: parent ? `New ${noun} inside ${parent.name}` : `New ${noun}`,
      description: layer === "code" ? "Use the repo path, e.g. src/lib/service.ts" : undefined,
      placeholder: "Name",
    });
    if (!name) return;
    run(async () => {
      const res = await upsertNodeAction(projectKey, {
        name,
        layer,
        parent: parentId,
        ...(layer === "code" ? { anchors: [name] } : {}),
      });
      if (res.ok) setSelectedId(res.data.id);
      return res;
    });
  };

  const counts = Object.fromEntries(LAYER_ORDER.map((l) => [l, graph.nodes.filter((n) => n.layer === l).length])) as Record<LayerId, number>;
  const staleCounts = Object.fromEntries(LAYER_ORDER.map((l) => [l, graph.nodes.filter((n) => n.layer === l && n.stale).length])) as Record<LayerId, number>;
  const lensEmpty = counts[lens] === 0;

  const banner =
    !activeFlow && !staleOnly && selected && selected.layer !== lens
      ? highlight.related?.size
        ? `Highlighting ${highlight.related.size} ${LAYER_META[lens].label.toLowerCase()} linked to ${selected.layer} “${selected.name}”`
        : `Nothing on the ${LAYER_META[lens].label} layer is linked to “${selected.name}” yet. Add “implements” links in its panel.`
      : staleOnly
        ? `Showing ${staleCounts[lens]} stale node(s): their code changed since they were described`
        : null;

  return (
    <div className="flex h-full">
      {flowsOpen && (
        <FlowsSidebar
          graph={graph}
          activeId={activeFlow?.id ?? null}
          onPlay={(id) => setPlay({ flowId: id, step: 0 })}
          onEdit={(f) => setEditor({ id: f.id, name: f.name, description: f.description, steps: f.steps.map((s) => ({ ...s })) })}
          onNew={() => setEditor({ name: "", description: "", steps: selected ? [{ nodeId: selected.id, title: "", detail: "" }] : [] })}
          onClose={() => (setFlowsOpen(false), setPlay(null))}
        />
      )}

      <div className="relative min-w-0 flex-1">
        <div className="absolute left-3 right-3 top-3 z-10 flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border border-line bg-panel p-0.5 text-sm" role="tablist" aria-label="Zoom level">
            {LAYER_ORDER.map((l) => (
              <button
                key={l}
                role="tab"
                aria-selected={lens === l}
                title={LAYER_META[l].hint}
                className={clsx("flex items-center gap-1.5 rounded px-3 py-1", lens === l ? "bg-panel-2 text-fg" : "text-muted hover:text-fg")}
                onClick={() => (setLens(l), setFocusId(null), setPlay(null), setColHl(null))}
              >
                {LAYER_META[l].label}
                <span className="text-[11px] text-muted">{counts[l]}</span>
                {staleCounts[l] > 0 && <span className="h-1.5 w-1.5 rounded-full bg-warn" title={`${staleCounts[l]} stale`} />}
              </button>
            ))}
          </div>
          {crumbs.length > 0 && (
            <div className="flex items-center gap-1 rounded-md border border-line bg-panel px-2 py-1 text-sm">
              <button className="text-muted hover:text-fg" onClick={() => setFocusId(null)}>All</button>
              {crumbs.map((c) => (
                <span key={c.id} className="flex items-center gap-1">
                  <span className="text-muted">›</span>
                  <button className={c.id === focusId ? "text-fg" : "text-muted hover:text-fg"} onClick={() => setFocusId(c.id)}>{c.name}</button>
                </span>
              ))}
            </div>
          )}
          <button className="btn btn-primary py-1" onClick={() => addNode(focusId)}>+ Add</button>
          <button className={clsx("btn py-1", flowsOpen && "border-accent")} onClick={() => setFlowsOpen((o) => !o)}>
            ▶ Flows <span className="text-muted">{graph.flows.length}</span>
          </button>
          {lens === "data" && counts.data > 1 && (
            <button className="btn py-1" onClick={tidyLayout} title="Arrange tables along their foreign keys">
              ⇆ Tidy
            </button>
          )}
          {lens !== "data" && counts[lens] > 1 && (
            <div className="flex items-center gap-1">
              <button
                className="btn py-1 disabled:opacity-50"
                disabled={laying}
                onClick={() => runAutoLayout(lens, layoutDir, false)}
                title="Auto-arrange this layer"
              >
                ⇆ Tidy
              </button>
              <button
                className="btn px-1.5 py-1 text-[11px]"
                title={layoutDir === "LR" ? "Switch to top-to-bottom" : "Switch to left-to-right"}
                onClick={() => setLayoutDir((d) => (d === "LR" ? "TB" : "LR"))}
              >
                {layoutDir === "LR" ? "→" : "↓"}
              </button>
            </div>
          )}
          {staleCounts[lens] > 0 && (
            <button className={clsx("btn py-1", staleOnly && "border-warn text-warn")} onClick={() => (setStaleOnly((s) => !s), setPlay(null))}>
              ⚠ {staleCounts[lens]} stale
            </button>
          )}
          <button className="btn py-1" onClick={() => (setAskFocus(null), setAskOpen(true))}>✨ Ask</button>
        </div>

        {banner && (
          <div className="absolute left-1/2 top-14 z-10 flex max-w-[90%] -translate-x-1/2 items-center gap-2 rounded-md border border-agent/40 bg-panel px-3 py-1.5 text-xs text-agent shadow">
            {banner}
            <button className="text-muted hover:text-fg" onClick={() => (staleOnly ? setStaleOnly(false) : setSelectedId(null))}>✕</button>
          </div>
        )}
        {selectedEdge && (
          <EdgeBar
            key={selectedEdge.id}
            from={`${byId.get(selectedEdge.fromNodeId)?.name ?? "?"}${selectedEdge.meta?.fromColumn ? "." + selectedEdge.meta.fromColumn : ""}`}
            to={`${byId.get(selectedEdge.toNodeId)?.name ?? "?"}${selectedEdge.meta?.toColumn ? "." + selectedEdge.meta.toColumn : ""}`}
            detail={
              selectedEdge.kind === "references"
                ? [selectedEdge.meta?.cardinality === "1-1" ? "one-to-one" : "many-to-one", selectedEdge.meta?.onDelete && `on delete ${selectedEdge.meta.onDelete}`]
                    .filter(Boolean)
                    .join(" · ")
                : undefined
            }
            label={selectedEdge.label}
            onLabel={(label) => run(() => connectNodesAction(projectKey, selectedEdge.fromNodeId, selectedEdge.toNodeId, label))}
            onDelete={() => removeEdge(selectedEdge.id)}
            onClose={() => setSelectedEdgeId(null)}
          />
        )}
        {undo && !selectedEdge && (
          <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3 rounded-md border border-line bg-panel px-3 py-2 text-sm shadow-xl">
            <span>{undo.text}</span>
            <button className="font-medium text-accent hover:underline" onClick={() => (undo.revert(), setUndo(null))}>
              Undo <span className="text-xs text-muted">⌘Z</span>
            </button>
            <button className="text-muted hover:text-fg" onClick={() => setUndo(null)} aria-label="Dismiss">✕</button>
          </div>
        )}
        {error && (
          <div className="absolute right-3 top-14 z-10 flex items-center gap-2 rounded-md border border-danger/40 bg-panel px-3 py-1.5 text-sm text-danger">
            {error} <button onClick={() => setError(null)}>✕</button>
          </div>
        )}

        {graph.nodes.length === 0 ? (
          <EmptyMap onAdd={() => addNode(null)} />
        ) : lensEmpty ? (
          <EmptyLayer lens={lens} onAdd={() => addNode(null)} />
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeDragStart={onNodeDragStart}
            onNodeDragStop={onNodeDragStop}
            onConnect={onConnect}
            onEdgesDelete={onEdgesDelete}
            onNodeClick={(_, n) => (setSelectedId(n.id), setSelectedEdgeId(null))}
            onEdgeClick={(_, e) => e.id !== "flow-step" && setSelectedEdgeId(e.id)}
            onNodeDoubleClick={(_, n) => (n.data as NodeData).hasChildren && setFocusId(n.id)}
            onPaneClick={() => (setSelectedEdgeId(null), setColHl(null), !play && setSelectedId(null))}
            deleteKeyCode={["Backspace", "Delete"]}
            onBeforeDelete={async ({ nodes }) => nodes.length === 0}
            colorMode={theme}
            fitView
            minZoom={0.1}
            proOptions={{ hideAttribution: true }}
          >
            <ErdMarkers />
            <Background gap={24} color="var(--flow-dots)" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor={(n) => KIND_STYLE[(n.data as NodeData).n.kind]?.color ?? "#888"} maskColor="var(--flow-mask)" />
          </ReactFlow>
        )}

        {activeFlow && play && step && (
          <FlowPlayer
            flow={activeFlow}
            index={play.step}
            nodeName={byId.get(step.nodeId)?.name ?? "?"}
            nodeLayer={byId.get(step.nodeId)?.layer ?? ""}
            onStep={(i) => setPlay({ flowId: activeFlow.id, step: i })}
            onClose={() => setPlay(null)}
            onLink={onInternalLink}
          />
        )}
      </div>

      {dialogs}
      <AskDialog
        open={askOpen}
        onOpenChange={setAskOpen}
        projectKey={projectKey}
        enabled={askEnabled}
        focus={askFocus}
        onLink={onInternalLink}
      />
      {editor && (
        <FlowEditor
          key={editor.id ?? "new"}
          open
          onOpenChange={(o) => !o && setEditor(null)}
          graph={graph}
          initial={editor}
          onSave={(f) => {
            setEditor(null);
            run(async () => {
              const res = await upsertFlowAction(projectKey, {
                id: f.id,
                name: f.name,
                description: f.description,
                steps: f.steps.map((s) => ({ node: s.nodeId, title: s.title, detail: s.detail })),
              });
              if (res.ok) {
                setFlowsOpen(true);
                if (res.data.steps.length) setPlay({ flowId: res.data.id, step: 0 });
              }
              return res;
            });
          }}
          onDelete={
            editor.id
              ? async () => {
                  if (!(await confirm({ title: `Delete flow “${editor.name}”?`, confirmLabel: "Delete", danger: true }))) return;
                  const id = editor.id!;
                  setEditor(null);
                  if (play?.flowId === id) setPlay(null);
                  run(() => deleteFlowAction(projectKey, id));
                }
              : undefined
          }
        />
      )}
      {selected && (
        <NodePanel
          key={selected.id + ":" + selected.version}
          node={selected}
          graph={graph}
          projectKey={projectKey}
          onClose={() => (setSelectedId(null), setPlay(null))}
          onSelect={selectNode}
          onAddChild={() => addNode(selected.id)}
          onFocus={() => setFocusId(selected.id)}
          onPlayFlow={(flowId, s) => (setFlowsOpen(true), setPlay({ flowId, step: Math.max(0, s) }))}
          onAsk={() => (setAskFocus(selected), setAskOpen(true))}
          onSave={(patch) => run(() => upsertNodeAction(projectKey, { id: selected.id, ...patch } as Parameters<typeof upsertNodeAction>[1]))}
          onLink={(from, to) => run(() => connectNodesAction(projectKey, from, to, undefined, "implements"))}
          onUnlink={(edgeId) => run(() => deleteEdgeAction(projectKey, edgeId))}
          onMarkFresh={() => run(() => markFreshAction(projectKey, selected.id))}
          onInternalLink={onInternalLink}
          onResolveDraft={(draftId, action) => run(() => resolveDraftAction(projectKey, draftId, action))}
          onDelete={async () => {
            const n = subtree(selected.id, graph.nodes).size - 1;
            const ok = await confirm({
              title: `Delete “${selected.name}”?`,
              description: n ? `This also deletes ${n} nested node(s).` : undefined,
              confirmLabel: "Delete",
              danger: true,
            });
            if (!ok) return;
            setSelectedId(null);
            if (focusId && subtree(selected.id, graph.nodes).has(focusId)) setFocusId(selected.parentId);
            run(() => deleteNodeAction(projectKey, selected.id));
          }}
        />
      )}
    </div>
  );
}

// ───────── edges ─────────

function EdgeBar(props: { from: string; to: string; label: string; detail?: string; onLabel: (l: string) => void; onDelete: () => void; onClose: () => void }) {
  const [label, setLabel] = useState(props.label);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);
  const commit = () => label !== props.label && props.onLabel(label.trim());
  return (
    <div className="absolute bottom-4 left-1/2 z-20 flex w-[min(92%,520px)] -translate-x-1/2 items-center gap-2 rounded-md border border-accent/40 bg-panel px-3 py-2 text-sm shadow-xl">
      <span className="shrink-0 truncate font-medium">
        {props.from} <span className="text-muted">→</span> {props.to}
      </span>
      {props.detail !== undefined ? (
        <span className="min-w-0 flex-1 truncate text-xs text-muted">{props.detail || "foreign key"}</span>
      ) : (
      <input
        className="input min-w-0 flex-1 py-1"
        placeholder="Label (e.g. REST, events)"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      )}
      <button className="btn btn-danger shrink-0 py-1" onClick={props.onDelete} title="Delete connection (Backspace)">
        Delete
      </button>
      <button className="shrink-0 text-muted hover:text-fg" onClick={props.onClose} aria-label="Close">✕</button>
    </div>
  );
}

// ───────── flows ─────────

function FlowsSidebar(props: {
  graph: Graph;
  activeId: string | null;
  onPlay: (id: string) => void;
  onEdit: (f: Graph["flows"][number]) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <span className="text-sm font-medium">Flows</span>
        <button className="btn btn-ghost px-2 py-0.5" onClick={props.onClose} aria-label="Close flows">✕</button>
      </div>
      <div className="flex-1 space-y-1 overflow-y-auto p-2 text-sm">
        {props.graph.flows.length === 0 && (
          <p className="px-2 py-3 text-xs text-muted">
            Flows are step-by-step walks through the map (“User signs up”, “Agent picks up a ticket”). They&apos;re the fastest way to understand
            how things fit together.
          </p>
        )}
        {props.graph.flows.map((f) => (
          <div
            key={f.id}
            className={clsx("group rounded-md border px-2.5 py-2", props.activeId === f.id ? "border-accent bg-accent/5" : "border-transparent hover:bg-panel-2")}
          >
            <button className="flex w-full items-center gap-2 text-left" onClick={() => props.onPlay(f.id)} disabled={!f.steps.length}>
              <span className="text-accent">▶</span>
              <span className="min-w-0 flex-1 truncate font-medium">{f.name}</span>
              <span className="text-[11px] text-muted">{f.steps.length}</span>
            </button>
            {f.description && <p className="mt-1 line-clamp-2 pl-5 text-xs text-muted">{f.description}</p>}
            <button className="mt-1 pl-5 text-[11px] text-muted opacity-0 hover:text-fg group-hover:opacity-100" onClick={() => props.onEdit(f)}>
              Edit
            </button>
          </div>
        ))}
      </div>
      <div className="border-t border-line p-2">
        <button className="btn w-full" onClick={props.onNew}>+ New flow</button>
      </div>
    </aside>
  );
}

function FlowPlayer(props: {
  flow: Graph["flows"][number];
  index: number;
  nodeName: string;
  nodeLayer: string;
  onStep: (i: number) => void;
  onClose: () => void;
  onLink: (href: string) => boolean;
}) {
  const { flow, index } = props;
  const s = flow.steps[index];
  const last = index === flow.steps.length - 1;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input,textarea,[contenteditable]")) return;
      if (e.key === "ArrowRight" && !last) props.onStep(index + 1);
      if (e.key === "ArrowLeft" && index > 0) props.onStep(index - 1);
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, last, props]);

  return (
    <div className="absolute bottom-4 left-1/2 z-10 w-[min(92%,560px)] -translate-x-1/2 rounded-lg border border-accent/40 bg-panel p-4 shadow-2xl">
      <div className="flex items-center gap-2 text-xs text-muted">
        <span className="font-medium text-accent">▶ {flow.name}</span>
        <span>
          step {index + 1} of {flow.steps.length}
        </span>
        <button className="ml-auto hover:text-fg" onClick={props.onClose} aria-label="Stop flow">✕</button>
      </div>
      <div className="mt-2 flex gap-1">
        {flow.steps.map((_, i) => (
          <button
            key={i}
            className={clsx("h-1 flex-1 rounded-full", i <= index ? "bg-accent" : "bg-line")}
            onClick={() => props.onStep(i)}
            aria-label={`Go to step ${i + 1}`}
          />
        ))}
      </div>
      <div className="mt-3 font-medium">{s.title}</div>
      <div className="text-xs text-muted">
        at <span className="uppercase">{props.nodeLayer}</span> · {props.nodeName}
      </div>
      {s.detail && <Markdown className="md mt-2 text-sm" onLink={props.onLink}>{s.detail}</Markdown>}
      <div className="mt-3 flex justify-between">
        <button className="btn py-1" disabled={index === 0} onClick={() => props.onStep(index - 1)}>← Back</button>
        {last ? (
          <button className="btn btn-primary py-1" onClick={props.onClose}>Done</button>
        ) : (
          <button className="btn btn-primary py-1" onClick={() => props.onStep(index + 1)}>Next →</button>
        )}
      </div>
    </div>
  );
}

// ───────── empty states ─────────

function EmptyMap({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-lg text-center">
        <div className="text-4xl">🗺️</div>
        <h2 className="mt-3 font-semibold">No knowledge map yet</h2>
        <p className="mt-2 text-sm text-muted">
          In Claude Code (with the Wheelhouse MCP server connected), run <span className="font-mono text-fg">/mcp__wheelhouse__map_codebase</span>. It
          maps your repo top-down into <b>Concepts</b> (what the product does), <b>Systems</b> (what runs where) and <b>Code</b> (where it lives),
          linked together, with flows that walk through how things work.
        </p>
        <button className="btn btn-primary mt-4" onClick={onAdd}>+ Start one by hand</button>
      </div>
    </div>
  );
}

function EmptyLayer({ lens, onAdd }: { lens: LayerId; onAdd: () => void }) {
  const copy: Record<LayerId, string> = {
    concept: "Concepts describe what the product does in plain language: capabilities, domain ideas and actors, with no file names.",
    system: "Systems are the deployable apps, services, datastores and queues, with their major modules nested inside.",
    data: "The data layer is your schema as an ER diagram: tables, columns, foreign keys and cardinality. In Claude Code, run /mcp__wheelhouse__map_schema to map it from your schema files.",
    code: "Code nodes are the directories, key files and endpoints behind each system, anchored to repo paths so they're flagged when the code changes.",
  };
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-md text-center">
        <h2 className="font-semibold">Nothing on the {LAYER_META[lens].label} layer yet</h2>
        <p className="mt-2 text-sm text-muted">{copy[lens]}</p>
        <button className="btn btn-primary mt-4" onClick={onAdd}>+ Add to {LAYER_META[lens].label}</button>
      </div>
    </div>
  );
}
