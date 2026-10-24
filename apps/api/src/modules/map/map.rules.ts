import * as schema from "../../db/schema";
import { ServiceError } from "../../common/service-error";
import { bad, finite, oneOf, text, textList, textOrNull } from "../../lib/web-input";
import type { NodeRow } from "./map.repository";
import type { Graph } from "./graph.service";

/** Pure rules of the map: no database, so they are tested on their own (anchors, kinds, columns, card heights, the request-body readers, the text the briefing and Ask are made of). */

type Body = Record<string, unknown>;
export type Layer = schema.Layer;

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
  /** Optimistic lock: the node version the caller last read. A different current version is a 409 and nothing changes. The web app sends it; agents' tools do not. */
  expectedVersion?: number;
  describedHashes?: Record<string, string>; // content hashes the explanation was written against
  x?: number;
  y?: number;
};

/** A session counts as active for this long after it was last seen. */
export const ACTIVE_SESSION_MS = 12 * 3600e3;

export const LAYER_RANK: Record<Layer, number> = { concept: 0, system: 1, data: 2, code: 3 };

export const EXPLAINER_FIELDS = ["summary", "purpose", "responsibilities", "interfaces", "gotchas", "details"] as const;

// ───────── anchors and freshness ─────────

export const normPath = (p: string) => p.trim().replace(/^\.\//, "").replace(/\\/g, "/");

/**
 * An anchor may carry an optional repo qualifier, "backend:src/**": only files
 * reported under that repo's slug/role match. A bare anchor ("src/db/**") has
 * no qualifier and matches files from any repository (the backward-compat
 * default — existing single-repo teams keep working with no action).
 *
 * Heuristic: a qualifier is a prefix before the first colon, itself containing
 * no "/" and no glob characters — real anchors are repo-relative paths/globs
 * ("src/db/**", "drizzle/**") which never start that way, so this never
 * misparses an existing anchor.
 */
export function parseAnchor(anchor: string): { repo: string | null; pattern: string } {
  const i = anchor.indexOf(":");
  if (i > 0) {
    const prefix = anchor.slice(0, i);
    if (!/[/*?]/.test(prefix)) return { repo: prefix.toLowerCase(), pattern: anchor.slice(i + 1) };
  }
  return { repo: null, pattern: anchor };
}

/**
 * How specifically `anchor` matches `file` (0 = no match). Longer literal
 * prefix = more specific. `fileRepo` is the repo slug/role the file was
 * reported under (from team_files.repositoryId / the session's file
 * tracking); an anchor qualified to a different repo never matches it, and an
 * unqualified anchor matches regardless of `fileRepo` (including when it's
 * unknown/null).
 */
export function anchorScore(anchor: string, file: string, fileRepo?: string | null) {
  const { repo, pattern } = parseAnchor(anchor);
  if (repo && (!fileRepo || fileRepo.toLowerCase() !== repo)) return 0;
  const a = normPath(pattern).split("#")[0];
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

/** Most specifically anchored nodes per layer for a file (same rule as report_changes). `fileRepo`: the repo slug this file was reported under, for repo-qualified anchors ("backend:src/**"). */
export function bestMatches(ns: NodeRow[], file: string, fileRepo?: string | null) {
  const best = new Map<string, { score: number; nodes: NodeRow[] }>();
  for (const n of ns) {
    const s = Math.max(0, ...n.anchors.map((a) => anchorScore(a, file, fileRepo)));
    if (!s) continue;
    const b = best.get(n.layer);
    if (!b || s > b.score) best.set(n.layer, { score: s, nodes: [n] });
    else if (s === b.score) b.nodes.push(n);
  }
  return [...best.values()].flatMap((b) => b.nodes);
}

export const anchoredBy = (n: { anchors: string[] }, files: string[], fileRepo?: string | null) => files.filter((f) => n.anchors.some((a) => anchorScore(a, f, fileRepo) > 0));

// ───────── nodes ─────────

export function defaultKind(layer: Layer, hasParent: boolean): (typeof schema.NODE_KINDS)[number] {
  if (layer === "concept") return hasParent ? "capability" : "concept";
  if (layer === "code") return hasParent ? "file" : "directory";
  if (layer === "data") return "table";
  return hasParent ? "module" : "service";
}

export function checkKind(layer: Layer, kind: string) {
  const allowed = schema.KINDS_BY_LAYER[layer] as readonly string[];
  if (!allowed.includes(kind))
    throw new ServiceError("invalid", `kind "${kind}" isn't valid on the ${layer} layer (use: ${allowed.join(", ")})`);
}

/** Rendered height of an ERD card, shared with the canvas so auto-placement doesn't overlap. */
export const tableHeight = (columns: number) => 48 + Math.max(1, columns) * 22;

export function cleanColumn(c: schema.Column): schema.Column {
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
export function nodeInput(b: Body): NodeInput {
  const out: NodeInput = {};
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

// ───────── the text of the briefing and of Ask ─────────

export const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.replace(/^[-*]\s*/, "").trim() ?? "";
export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Join sections in priority order until the character budget is spent. */
export function budgeted(sections: (string | null)[], max: number) {
  const out: string[] = [];
  let used = 0;
  for (const s of sections) {
    if (!s) continue;
    if (used + s.length > max) {
      const room = max - used;
      if (room > 200) out.push(clip(s, room) + "\n");
      out.push(`_(briefing trimmed to ${max} chars; drill in with get_graph / get_node / get_flows)_`);
      break;
    }
    out.push(s);
    used += s.length;
  }
  return out.join("\n");
}

export function askEnabled() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/** Deterministic rendering (stable ordering) so the cached prefix survives across questions. */
export function renderMap(g: Graph) {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const label = (id: string) => {
    const n = byId.get(id);
    return n ? `${n.layer}:${n.name}` : "?";
  };
  const out: string[] = [`# Team ${g.team.key}: ${g.team.name}`, g.team.description, ""];
  for (const layer of ["concept", "system", "data", "code"] as const) {
    const ns = g.nodes.filter((n) => n.layer === layer);
    if (!ns.length) continue;
    out.push(`## ${layer.toUpperCase()} LAYER`);
    const kids = (pid: string | null) => ns.filter((n) => n.parentId === pid).sort((a, b) => a.name.localeCompare(b.name));
    const walk = (pid: string | null, depth: number) => {
      for (const n of kids(pid)) {
        const h = "#".repeat(Math.min(3 + depth, 6));
        out.push(`${h} ${layer}:${n.name} (${n.kind}, ${n.status}${n.stale ? ", STALE" : ""})`);
        if (n.summary) out.push(n.summary);
        if (n.purpose) out.push(`Purpose: ${n.purpose}`);
        if (n.responsibilities) out.push(`Responsibilities:\n${n.responsibilities}`);
        if (n.interfaces) out.push(`Interfaces:\n${n.interfaces}`);
        if (n.gotchas) out.push(`Gotchas:\n${n.gotchas}`);
        if (n.details) out.push(`Notes:\n${n.details}`);
        if (n.columns.length)
          out.push(
            `Columns:\n${n.columns
              .map((c) => `- ${c.name} ${c.type}${c.pk ? " PK" : ""}${c.unique ? " UNIQUE" : ""}${c.nullable ? " NULL" : ""}${c.references ? ` → ${c.references}${c.onDelete ? ` (on delete ${c.onDelete})` : ""}` : ""}${c.note ? ` — ${c.note}` : ""}`)
              .join("\n")}`,
          );
        if (n.anchors.length) out.push(`Code anchors: ${n.anchors.join(", ")}`);
        const deps = g.edges.filter((e) => e.kind === "depends" && e.fromNodeId === n.id);
        if (deps.length) out.push(`Depends on: ${deps.map((e) => label(e.toNodeId) + (e.label ? ` (${e.label})` : "")).sort().join("; ")}`);
        const impl = g.edges.filter((e) => e.kind === "implements" && e.fromNodeId === n.id);
        if (impl.length) out.push(`Implements: ${impl.map((e) => label(e.toNodeId)).sort().join("; ")}`);
        out.push("");
        walk(n.id, depth + 1);
      }
    };
    walk(null, 0);
  }
  if (g.flows.length) {
    out.push("## FLOWS");
    for (const f of [...g.flows].sort((a, b) => a.name.localeCompare(b.name))) {
      out.push(`### Flow: ${f.name}`, f.description);
      f.steps.forEach((s, i) => out.push(`${i + 1}. [${label(s.nodeId)}] ${s.title}${s.detail ? ` — ${s.detail}` : ""}`));
      out.push("");
    }
  }
  if (g.decisions.length) {
    out.push("## DECISIONS");
    for (const d of g.decisions) {
      out.push(`### ADR-${d.number}: ${d.title} (${d.status})`);
      if (d.context) out.push(`Context: ${d.context}`);
      if (d.decision) out.push(`Decision: ${d.decision}`);
      if (d.consequences) out.push(`Consequences: ${d.consequences}`);
      if (d.nodeIds.length) out.push(`Applies to: ${d.nodeIds.map(label).sort().join("; ")}`);
      out.push("");
    }
  }
  if (g.terms.length) {
    out.push("## GLOSSARY");
    for (const t of g.terms) out.push(`- **${t.term}**: ${t.definition}`);
  }
  return out.join("\n");
}
