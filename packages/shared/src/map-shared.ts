// Client-safe helpers shared by the map UI (no server imports).

export type LayerId = "concept" | "system" | "data" | "code";

export const LAYER_META: Record<LayerId, { label: string; hint: string; rank: number }> = {
  concept: { label: "Concepts", hint: "What the product does", rank: 0 },
  system: { label: "Systems", hint: "What runs where", rank: 1 },
  data: { label: "Data", hint: "What's stored and how it relates", rank: 2 },
  code: { label: "Code", hint: "Where it lives", rank: 3 },
};
export const LAYER_ORDER: LayerId[] = ["concept", "system", "data", "code"];

export const KINDS: Record<LayerId, string[]> = {
  concept: ["concept", "capability", "actor"],
  system: ["service", "module", "component", "database", "queue", "external"],
  data: ["table", "view", "enum"],
  code: ["directory", "file", "symbol", "endpoint"],
};

export const KIND_STYLE: Record<string, { icon: string; color: string }> = {
  concept: { icon: "✦", color: "#d946ef" },
  capability: { icon: "◎", color: "#ec4899" },
  actor: { icon: "☺", color: "#eab308" },
  service: { icon: "▣", color: "var(--accent)" },
  module: { icon: "◆", color: "#f59e0b" },
  component: { icon: "●", color: "#10b981" },
  database: { icon: "⛁", color: "#ec4899" },
  queue: { icon: "≋", color: "#f97316" },
  external: { icon: "☁", color: "#8b95a5" },
  directory: { icon: "▤", color: "#64748b" },
  file: { icon: "▢", color: "#0ea5e9" },
  symbol: { icon: "ƒ", color: "#22c55e" },
  table: { icon: "⊞", color: "#14b8a6" },
  view: { icon: "◫", color: "#8b5cf6" },
  enum: { icon: "≡", color: "#f59e0b" },
  endpoint: { icon: "⇄", color: "#eab308" },
};

export const STATUS_STYLE: Record<string, string> = {
  planned: "text-muted",
  building: "text-warn",
  live: "text-ok",
  deprecated: "text-danger line-through",
};

type N = { id: string; layer: string; parentId: string | null };
type E = { kind: string; fromNodeId: string; toNodeId: string };

/**
 * Nodes on `target` layer connected to `fromId` through implements links,
 * walking monotonically toward the target layer (concept → system → code or
 * back), so we don't wander sideways into unrelated concepts.
 */
export function relatedOnLayer(fromId: string, target: LayerId, nodes: N[], edges: E[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const start = byId.get(fromId);
  if (!start) return new Set<string>();
  const rank = (id: string) => LAYER_META[byId.get(id)!.layer as LayerId].rank;
  const goal = LAYER_META[target].rank;
  const impl = edges.filter((e) => e.kind === "implements" && byId.has(e.fromNodeId) && byId.has(e.toNodeId));
  // Treat a node's descendants as part of it (a service's modules implement what the service does).
  const withKids = (id: string) => {
    const out = [id];
    for (let i = 0; i < out.length; i++) for (const n of nodes) if (n.parentId === out[i]) out.push(n.id);
    return out;
  };
  const seen = new Set<string>(withKids(fromId));
  const queue = [...seen];
  const found = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    const r = rank(id);
    if (r === goal) {
      found.add(id);
      continue;
    }
    for (const e of impl) {
      const other = e.fromNodeId === id ? e.toNodeId : e.toNodeId === id ? e.fromNodeId : null;
      if (!other || seen.has(other)) continue;
      if (Math.abs(rank(other) - goal) >= Math.abs(r - goal)) continue;
      for (const k of withKids(other)) {
        if (!seen.has(k)) {
          seen.add(k);
          queue.push(k);
        }
      }
    }
  }
  return found;
}

export function subtree(rootId: string, all: { id: string; parentId: string | null }[]) {
  const ids = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of all) if (n.parentId && ids.has(n.parentId) && !ids.has(n.id)) {
      ids.add(n.id);
      grew = true;
    }
  }
  return ids;
}

/** "[[system:Service layer]]" → markdown link the UI intercepts. */
export function linkifyRefs(md: string) {
  return md
    .replace(/\[\[([^\]]+)\]\]/g, (_, ref: string) => `[${ref.replace(/^(concept|system|data|code):/i, "")}](#node:${encodeURIComponent(ref)})`)
    .replace(/\bADR-(\d+)\b/g, (m, n) => `[${m}](#adr:${n})`);
}

// ───────── data layer (ERD) ─────────

export type Column = {
  name: string;
  type: string;
  nullable?: boolean;
  pk?: boolean;
  unique?: boolean;
  default?: string;
  references?: string;
  onDelete?: string;
  note?: string;
};

/** Must match tableHeight() in lib/service.ts (auto-placement) and the card's CSS. */
export const TABLE_W = 280;
export const TABLE_HEADER_H = 40;
export const TABLE_ROW_H = 22;
export const tableHeight = (columns: number) => TABLE_HEADER_H + 8 + Math.max(1, columns) * TABLE_ROW_H;
