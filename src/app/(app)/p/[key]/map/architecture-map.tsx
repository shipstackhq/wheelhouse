"use client";

import "@xyflow/react/dist/style.css";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
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
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import clsx from "clsx";
import {
  connectNodesAction,
  deleteEdgeAction,
  deleteNodeAction,
  getGraphAction,
  saveLayoutAction,
  upsertNodeAction,
} from "@/app/actions";

type Graph = Extract<Awaited<ReturnType<typeof getGraphAction>>, { ok: true }>["data"];
type GNode = Graph["nodes"][number];

const KIND_STYLE: Record<string, { icon: string; color: string }> = {
  service: { icon: "▣", color: "#f5a524" },
  module: { icon: "◆", color: "#60a5fa" },
  component: { icon: "●", color: "#34d399" },
  database: { icon: "⛁", color: "#f472b6" },
  queue: { icon: "≋", color: "#fb923c" },
  external: { icon: "☁", color: "#94a3b8" },
};
const STATUS_STYLE: Record<string, string> = {
  planned: "text-muted",
  building: "text-accent",
  live: "text-ok",
  deprecated: "text-danger line-through",
};

const LEAF_W = 190;
const LEAF_H = 64;

type NodeData = {
  n: GNode;
  hasChildren: boolean;
  tickets: number;
  onFocus: (id: string) => void;
};

const BoxNode = memo(function BoxNode({ data, selected }: NodeProps<Node<NodeData>>) {
  const { n, hasChildren, tickets } = data;
  const k = KIND_STYLE[n.kind] ?? KIND_STYLE.service;
  if (hasChildren) {
    return (
      <div
        className={clsx("h-full w-full rounded-xl border-2 bg-panel/70", selected ? "border-accent" : "border-line")}
        style={{ borderTopColor: k.color }}
      >
        <NodeResizer isVisible={selected} minWidth={240} minHeight={140} lineClassName="!border-accent" handleClassName="!bg-accent" />
        <Handle type="target" position={Position.Left} />
        <div className="flex items-start gap-2 border-b border-line/70 px-3 py-2">
          <span style={{ color: k.color }}>{k.icon}</span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold">{n.name}</span>
              <span className={clsx("text-[10px] uppercase", STATUS_STYLE[n.status])}>{n.status}</span>
            </div>
            {n.summary && <div className="truncate text-[11px] text-muted">{n.summary}</div>}
          </div>
          {tickets > 0 && <span className="chip bg-bg text-muted">{tickets} 🎫</span>}
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
  return (
    <div
      className={clsx("rounded-lg border bg-panel-2 px-3 py-2 shadow-sm", selected ? "border-accent" : "border-line")}
      style={{ width: LEAF_W, minHeight: LEAF_H, borderLeft: `3px solid ${k.color}` }}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-1.5">
        <span className="text-xs" style={{ color: k.color }}>{k.icon}</span>
        <span className="truncate text-[13px] font-medium">{n.name}</span>
        {tickets > 0 && <span className="ml-auto text-[10px] text-muted">{tickets}🎫</span>}
      </div>
      {n.summary && <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted">{n.summary}</div>}
      <div className={clsx("mt-1 text-[9px] uppercase", STATUS_STYLE[n.status])}>{n.kind} · {n.status}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

const nodeTypes = { box: BoxNode };

function depthOf(id: string, byId: Map<string, GNode>) {
  let d = 0;
  let cur = byId.get(id);
  while (cur?.parentId && d < 20) {
    cur = byId.get(cur.parentId);
    d++;
  }
  return d;
}

function subtree(rootId: string, all: GNode[]) {
  const ids = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of all) if (n.parentId && ids.has(n.parentId) && !ids.has(n.id)) (ids.add(n.id), (grew = true));
  }
  return ids;
}

/** Size a group to fit its children unless the user has resized it. */
function groupSize(n: GNode, children: GNode[], sizes: Map<string, { w: number; h: number }>) {
  if (n.width && n.height) return { w: n.width, h: n.height };
  let w = 260;
  let h = 140;
  for (const c of children) {
    const s = sizes.get(c.id) ?? { w: LEAF_W, h: LEAF_H + 16 };
    w = Math.max(w, c.x + s.w + 24);
    h = Math.max(h, c.y + s.h + 24);
  }
  return { w, h };
}

function toFlow(g: Graph, focusId: string | null, onFocus: (id: string) => void) {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const visible = focusId ? subtree(focusId, g.nodes) : new Set(g.nodes.map((n) => n.id));
  const kids = new Map<string, GNode[]>();
  for (const n of g.nodes) if (n.parentId) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);
  const ticketCount = new Map<string, number>();
  for (const l of g.ticketLinks) ticketCount.set(l.nodeId, (ticketCount.get(l.nodeId) ?? 0) + 1);

  // Deepest first so group sizes can include their children's sizes.
  const ordered = g.nodes.filter((n) => visible.has(n.id)).sort((a, b) => depthOf(b.id, byId) - depthOf(a.id, byId));
  const sizes = new Map<string, { w: number; h: number }>();
  for (const n of ordered) {
    const c = kids.get(n.id) ?? [];
    if (c.length) sizes.set(n.id, groupSize(n, c, sizes));
  }

  // React Flow needs parents before children.
  const nodes: Node<NodeData>[] = [...ordered].reverse().map((n) => {
    const hasChildren = (kids.get(n.id)?.length ?? 0) > 0;
    const parentVisible = n.parentId && visible.has(n.parentId) && n.id !== focusId;
    const s = sizes.get(n.id);
    return {
      id: n.id,
      type: "box",
      position: { x: n.x, y: n.y },
      ...(parentVisible ? { parentId: n.parentId!, extent: "parent" as const } : {}),
      ...(hasChildren ? { style: { width: s!.w, height: s!.h }, zIndex: 0 } : { zIndex: 1 }),
      data: { n, hasChildren, tickets: ticketCount.get(n.id) ?? 0, onFocus },
    };
  });

  const edges: Edge[] = g.edges
    .filter((e) => visible.has(e.fromNodeId) && visible.has(e.toNodeId))
    .map((e) => ({
      id: e.id,
      source: e.fromNodeId,
      target: e.toNodeId,
      label: e.label || undefined,
      type: "smoothstep",
      zIndex: 2,
      markerEnd: { type: MarkerType.ArrowClosed, color: "#8a93a6" },
      style: { stroke: "#8a93a6" },
      labelStyle: { fill: "#e6e9ef", fontSize: 11 },
      labelBgStyle: { fill: "#121722" },
    }));
  return { nodes, edges };
}

export function ArchitectureMap(props: { projectKey: string; initial: Graph }) {
  return (
    <ReactFlowProvider>
      <MapInner {...props} />
    </ReactFlowProvider>
  );
}

function MapInner({ projectKey, initial }: { projectKey: string; initial: Graph }) {
  const [graph, setGraph] = useState<Graph>(initial);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();
  const busy = useRef(false);
  const rf = useReactFlow();

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

  const flow = useMemo(() => toFlow(graph, focusId, setFocusId), [graph, focusId]);
  const [nodes, setNodes] = useState(flow.nodes);
  useEffect(() => setNodes(flow.nodes.map((n) => ({ ...n, selected: n.id === selectedId }))), [flow.nodes, selectedId]);
  useEffect(() => {
    const t = setTimeout(() => rf.fitView({ padding: 0.15, duration: 300 }), 50);
    return () => clearTimeout(t);
  }, [focusId, rf]);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      busy.current = true;
      const res = await fn();
      busy.current = false;
      if (!res.ok) setError(res.error ?? "Failed");
      await reload();
    });

  const onNodesChange = useCallback((changes: NodeChange<Node<NodeData>>[]) => {
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
  }, [projectKey, graph.nodes, reload]);

  const onNodeDragStart = () => (busy.current = true);
  const onNodeDragStop = (_: unknown, __: Node, dragged: Node[]) => {
    const positions = dragged.map((d) => ({ id: d.id, x: Math.round(d.position.x), y: Math.round(d.position.y) }));
    saveLayoutAction(projectKey, positions).then(() => {
      busy.current = false;
      setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => { const p = positions.find((x) => x.id === n.id); return p ? { ...n, x: p.x, y: p.y } : n; }) }));
    });
  };

  const onConnect = (c: Connection) => {
    if (!c.source || !c.target || c.source === c.target) return;
    run(() => connectNodesAction(projectKey, c.source!, c.target!));
  };

  const onEdgesDelete = (es: Edge[]) => es.forEach((e) => run(() => deleteEdgeAction(projectKey, e.id)));

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const crumbs: GNode[] = [];
  for (let cur = focusId ? byId.get(focusId) : undefined; cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) crumbs.unshift(cur);
  const selected = selectedId ? byId.get(selectedId) : undefined;

  const addNode = (parentId: string | null) => {
    const name = prompt(parentId ? `New module inside ${byId.get(parentId)?.name}` : "New service name");
    if (!name?.trim()) return;
    run(async () => {
      const res = await upsertNodeAction(projectKey, { name: name.trim(), parent: parentId });
      if (res.ok) setSelectedId(res.data.id);
      return res;
    });
  };

  return (
    <div className="flex h-full">
      <div className="relative min-w-0 flex-1">
        <div className="absolute left-3 top-3 z-10 flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-md border border-line bg-panel px-2 py-1 text-sm">
            <button className={focusId ? "text-muted hover:text-fg" : "text-fg"} onClick={() => setFocusId(null)}>All systems</button>
            {crumbs.map((c) => (
              <span key={c.id} className="flex items-center gap-1">
                <span className="text-muted">›</span>
                <button className={c.id === focusId ? "text-fg" : "text-muted hover:text-fg"} onClick={() => setFocusId(c.id)}>{c.name}</button>
              </span>
            ))}
          </div>
          <button className="btn btn-primary py-1" onClick={() => addNode(focusId)}>+ {focusId ? "Module" : "Service"}</button>
        </div>
        {error && (
          <div className="absolute right-3 top-3 z-10 flex items-center gap-2 rounded-md border border-danger/40 bg-panel px-3 py-1.5 text-sm text-danger">
            {error} <button onClick={() => setError(null)}>✕</button>
          </div>
        )}
        {graph.nodes.length === 0 ? (
          <EmptyMap onAdd={() => addNode(null)} />
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={flow.edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeDragStart={onNodeDragStart}
            onNodeDragStop={onNodeDragStop}
            onConnect={onConnect}
            onEdgesDelete={onEdgesDelete}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onNodeDoubleClick={(_, n) => (n.data as NodeData).hasChildren && setFocusId(n.id)}
            onPaneClick={() => setSelectedId(null)}
            deleteKeyCode={["Backspace", "Delete"]}
            onBeforeDelete={async ({ nodes }) => nodes.length === 0}
            colorMode="dark"
            fitView
            minZoom={0.1}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} color="#232b3a" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor={(n) => KIND_STYLE[(n.data as NodeData).n.kind]?.color ?? "#555"} maskColor="rgba(11,14,20,0.7)" />
          </ReactFlow>
        )}
      </div>
      {selected && (
        <NodePanel
          key={selected.id + selected.version}
          node={selected}
          all={graph.nodes}
          tickets={graph.ticketLinks.filter((l) => l.nodeId === selected.id)}
          projectKey={projectKey}
          onClose={() => setSelectedId(null)}
          onAddChild={() => addNode(selected.id)}
          onFocus={() => setFocusId(selected.id)}
          onSave={(patch) => run(() => upsertNodeAction(projectKey, { id: selected.id, ...patch }))}
          onDelete={() => {
            const n = subtree(selected.id, graph.nodes).size - 1;
            if (!confirm(`Delete "${selected.name}"${n ? ` and ${n} nested node(s)` : ""}?`)) return;
            setSelectedId(null);
            if (focusId && subtree(selected.id, graph.nodes).has(focusId)) setFocusId(selected.parentId);
            run(() => deleteNodeAction(projectKey, selected.id));
          }}
        />
      )}
    </div>
  );
}

function EmptyMap({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-md text-center">
        <div className="text-4xl">🗺️</div>
        <h2 className="mt-3 font-semibold">No architecture mapped yet</h2>
        <p className="mt-2 text-sm text-muted">
          Ask your agent: <span className="font-mono text-fg">&quot;Map this codebase&apos;s architecture into Wheelhouse&quot;</span> — it will create
          services with nested modules via MCP. Or start one by hand.
        </p>
        <button className="btn btn-primary mt-4" onClick={onAdd}>+ Add a service</button>
      </div>
    </div>
  );
}

function NodePanel(props: {
  node: GNode;
  all: GNode[];
  tickets: Graph["ticketLinks"];
  projectKey: string;
  onClose: () => void;
  onAddChild: () => void;
  onFocus: () => void;
  onSave: (patch: { name?: string; summary?: string; details?: string; kind?: GNode["kind"]; status?: GNode["status"]; parent?: string | null }) => void;
  onDelete: () => void;
}) {
  const { node: n, all } = props;
  const [name, setName] = useState(n.name);
  const [summary, setSummary] = useState(n.summary);
  const [details, setDetails] = useState(n.details);
  const [editing, setEditing] = useState(false);
  const children = all.filter((c) => c.parentId === n.id);
  const invalidParents = subtree(n.id, all);

  return (
    <aside className="flex w-[420px] shrink-0 flex-col border-l border-line bg-panel">
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <span className="text-xs text-muted">v{n.version} · {n.kind}</span>
        <button className="btn btn-ghost px-2 py-1" onClick={props.onClose}>✕</button>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4 text-sm">
        <input
          className="w-full bg-transparent text-lg font-semibold outline-none"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== n.name && props.onSave({ name: name.trim() })}
        />
        <input
          className="input"
          placeholder="One-line summary"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          onBlur={() => summary !== n.summary && props.onSave({ summary })}
        />
        <div className="grid grid-cols-3 gap-2">
          <div>
            <span className="label">Kind</span>
            <select className="input py-1.5" value={n.kind} onChange={(e) => props.onSave({ kind: e.target.value as GNode["kind"] })}>
              {Object.keys(KIND_STYLE).map((k) => <option key={k}>{k}</option>)}
            </select>
          </div>
          <div>
            <span className="label">Status</span>
            <select className="input py-1.5" value={n.status} onChange={(e) => props.onSave({ status: e.target.value as GNode["status"] })}>
              {["planned", "building", "live", "deprecated"].map((s) => <option key={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <span className="label">Inside</span>
            <select className="input py-1.5" value={n.parentId ?? ""} onChange={(e) => props.onSave({ parent: e.target.value || null })}>
              <option value="">(top level)</option>
              {all.filter((p) => !invalidParents.has(p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        </div>

        <section>
          <div className="mb-1 flex items-center justify-between">
            <span className="label mb-0">Details</span>
            <button className="text-xs text-muted hover:text-fg" onClick={() => (editing ? (props.onSave({ details }), setEditing(false)) : setEditing(true))}>
              {editing ? "Save" : "Edit"}
            </button>
          </div>
          {editing ? (
            <textarea className="input font-mono text-[13px]" rows={14} value={details} onChange={(e) => setDetails(e.target.value)} />
          ) : n.details ? (
            <div className="md rounded-md bg-bg/50 p-3"><ReactMarkdown remarkPlugins={[remarkGfm]}>{n.details}</ReactMarkdown></div>
          ) : (
            <p className="text-muted">No details yet. Responsibilities, key files, interfaces, gotchas — agents keep this updated.</p>
          )}
        </section>

        <section>
          <div className="mb-1 flex items-center justify-between">
            <span className="label mb-0">Contains ({children.length})</span>
            <div className="flex gap-3 text-xs">
              {children.length > 0 && <button className="text-muted hover:text-fg" onClick={props.onFocus}>Drill in ⤢</button>}
              <button className="text-accent" onClick={props.onAddChild}>+ Add</button>
            </div>
          </div>
          <ul className="space-y-1">
            {children.map((c) => (
              <li key={c.id} className="flex gap-2">
                <span style={{ color: KIND_STYLE[c.kind]?.color }}>{KIND_STYLE[c.kind]?.icon}</span>
                <span>{c.name}</span>
                <span className="truncate text-muted">{c.summary}</span>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <span className="label">Tickets touching this</span>
          {props.tickets.length === 0 ? (
            <p className="text-muted">None linked.</p>
          ) : (
            <ul className="space-y-1">
              {props.tickets.map((t) => (
                <li key={t.ticketId}>
                  <Link className="hover:text-accent" href={`/p/${props.projectKey}?t=${t.ref}`}>
                    <span className="font-mono text-xs text-muted">{t.ref}</span> {t.title}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <button className="btn btn-danger" onClick={props.onDelete}>Delete node</button>
      </div>
    </aside>
  );
}
