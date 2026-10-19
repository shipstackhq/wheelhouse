// Collapse/expand state for container nodes on the map (WH-22), persisted per browser following
// the exact loadView/saveView localStorage pattern from column-controls.tsx. No new DB schema.

export function collapseKey(teamKey: string, lens: string) {
  return `wh:map-collapsed:${teamKey}:${lens}`;
}

export function loadCollapsed(storageKey: string): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) return new Set(JSON.parse(raw));
  } catch {}
  return new Set();
}

export function saveCollapsed(storageKey: string, ids: Set<string>) {
  try {
    if (ids.size) localStorage.setItem(storageKey, JSON.stringify([...ids]));
    else localStorage.removeItem(storageKey);
  } catch {}
}

/**
 * Has this container been visited before (collapsed or explicitly expanded)? Containers default
 * to collapsed, but once a person expands one we must remember that too, or it'd snap shut again
 * on the next render. We store both sets: `collapsed` (currently collapsed) and `seen` (ever toggled),
 * so "default collapsed" only applies to containers nobody has touched yet.
 */
export function seenKey(teamKey: string, lens: string) {
  return `wh:map-collapsed-seen:${teamKey}:${lens}`;
}

type CollapseEdge = { id: string; fromNodeId: string; toNodeId: string; kind: string; label?: string | null };

/**
 * WH-22: redirect edges touching a hidden (collapsed-away) node to the nearest visible ancestor,
 * then merge duplicates created by that redirection into one edge carrying a "×N" count.
 * Pulled out of knowledge-map.tsx's toFlow() as a pure, unit-testable function — it takes plain
 * data (no React Flow/DOM types) so it can be exercised without mounting the map.
 *
 * `nearestVisible(id)` must walk up to the closest ancestor not in the hidden set (itself if
 * already visible) — callers build this from their own node tree (see toFlow's `nearestVisible`).
 */
export function remapCollapsedEdges<E extends CollapseEdge>(edges: E[], nearestVisible: (id: string) => string): E[] {
  const merged = new Map<string, { e: E; count: number }>();
  for (const e of edges) {
    const from = nearestVisible(e.fromNodeId);
    const to = nearestVisible(e.toNodeId);
    if (from === to) continue; // both ends collapsed into the same ancestor: not worth drawing
    const key = `${from}>${to}>${e.kind}`;
    const existing = merged.get(key);
    if (existing) existing.count++;
    else merged.set(key, { e: { ...e, fromNodeId: from, toNodeId: to }, count: 1 });
  }
  return [...merged.values()].map(({ e, count }) => (count > 1 ? { ...e, label: e.label ? `${e.label} ×${count}` : `×${count}` } : e));
}
