import type { Actor } from "../../common/actor";
import { normPath } from "../map/index";

/** Pure rules of the docs area: no database, so they are tested on their own. */

export const DOC_BODY_MAX_BYTES = 200_000; // 200 KB
// Drawings (WH-146): the body is Excalidraw scene JSON. Pasted images stay inside the scene (`files`, base64), so the limit is raised
// instead of adding file storage; the SVG thumbnail has its own, smaller limit.
export const DRAWING_BODY_MAX_BYTES = 2_000_000; // 2 MB
export const DRAWING_THUMBNAIL_MAX_BYTES = 300_000; // 300 KB
export const EMPTY_DRAWING = JSON.stringify({ type: "excalidraw", version: 2, elements: [], appState: {}, files: {} });

/** A drawing body must be a JSON object (the Excalidraw scene); returns the reason it is not, or undefined. */
export function drawingBodyProblem(body: string): string | undefined {
  try {
    const v = JSON.parse(body);
    return v && typeof v === "object" && !Array.isArray(v) ? undefined : "Drawing body must be a JSON object (the Excalidraw scene)";
  } catch {
    return "Drawing body must be valid JSON (the Excalidraw scene)";
  }
}

/** A thumbnail is an SVG document; it is only ever shown through <img>, never inlined. */
export const isSvg = (s: string) => /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(s);

export const DOC_MAX_DEPTH = 4;
export const DOC_MAX_PER_TEAM = 500;

/** Humans can always write docs; agent keys need the "docs:write" capability. */
export function canWriteDocs(actor: Actor, capabilities?: string[]) {
  if (actor.kind === "human") return true;
  return (capabilities ?? []).includes("docs:write");
}

export function slugifyDoc(title: string) {
  return (
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "doc"
  );
}

/**
 * Lightweight heuristic (WH-64, scope B): pull file-path-looking tokens out of a doc's
 * Markdown — inline code spans (`` `src/lib/x.ts` ``) and bare tokens that look like a
 * repo-relative path (contain a "/" and end in a plausible extension, or end in "/" for
 * a directory). Not an NLP system — a few false negatives/positives are fine, since the
 * issue says these are SUGGESTIONS the author confirms, never auto-applied.
 */
export const PATH_TOKEN_RE = /[A-Za-z0-9_.*-]+(?:\/[A-Za-z0-9_.*-]+)+\/?/g;
export const LIKELY_PATH_RE = /^(?:[A-Za-z0-9_.-]+\/)+(?:[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}|\*\*?|[A-Za-z0-9_.*-]+)\/?$/;

export function extractPathTokens(markdown: string): string[] {
  const codeSpans = [...markdown.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  const bare = [...markdown.matchAll(PATH_TOKEN_RE)].map((m) => m[0]);
  const candidates = [...codeSpans, ...bare].map((s) => s.trim().replace(/[.,;:!?)]+$/, "")).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    const p = normPath(c);
    if (!LIKELY_PATH_RE.test(p) && !/[*?]/.test(p)) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

export function clipText(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ───────── drawings as text (WH-150) ─────────

type SceneElement = {
  id?: string;
  type?: string;
  text?: string;
  isDeleted?: boolean;
  containerId?: string | null;
  startBinding?: { elementId?: string } | null;
  endBinding?: { elementId?: string } | null;
};

const OUTLINE_MAX_ITEMS = 200;
const oneLine = (s: string) => clipText(s.replace(/\s+/g, " ").trim(), 120);

/**
 * A short plain-text outline of an Excalidraw scene for agents: the labelled boxes, the connections between them (A → B) and any free
 * text. Never the scene JSON. Unparseable input gives an empty outline. Pure, so it is tested on its own.
 */
export function drawingOutline(sceneJson: string): { text: string; shapes: number; connections: number } {
  let elements: SceneElement[] = [];
  try {
    const scene = JSON.parse(sceneJson) as { elements?: unknown };
    if (Array.isArray(scene.elements)) elements = scene.elements.filter((e): e is SceneElement => !!e && typeof e === "object" && !(e as SceneElement).isDeleted);
  } catch {
    // not a scene: nothing to outline
  }
  const byId = new Map(elements.filter((e) => e.id).map((e) => [e.id!, e]));
  // The text bound inside a container (a box or an arrow), by container id.
  const labelOf = new Map<string, string>();
  const freeText: string[] = [];
  for (const e of elements) {
    if (e.type !== "text" || !e.text?.trim()) continue;
    if (e.containerId && byId.has(e.containerId)) labelOf.set(e.containerId, oneLine(e.text));
    else freeText.push(oneLine(e.text));
  }
  const isLink = (e: SceneElement) => e.type === "arrow" || e.type === "line";
  const nameOf = (id: string | undefined) => {
    const e = id ? byId.get(id) : undefined;
    if (!e) return "(nothing)";
    return labelOf.get(e.id!) ?? `(unlabeled ${e.type ?? "shape"})`;
  };
  const shapes = elements.filter((e) => e.type && e.type !== "text" && !isLink(e) && e.type !== "freedraw" && e.type !== "image");
  const labelled = shapes.map((e) => labelOf.get(e.id!)).filter((l): l is string => !!l);
  const unlabeled = shapes.length - labelled.length;
  const boxLines = unlabeled ? [...labelled, `(${unlabeled} unlabeled shape${unlabeled === 1 ? "" : "s"})`] : labelled;
  const links = elements.filter(isLink).map((e) => {
    const label = labelOf.get(e.id!);
    return `${nameOf(e.startBinding?.elementId)} → ${nameOf(e.endBinding?.elementId)}${label ? ` (${label})` : ""}`;
  });
  const section = (title: string, lines: string[]) =>
    lines.length ? `${title}:\n${lines.slice(0, OUTLINE_MAX_ITEMS).map((l) => `- ${l}`).join("\n")}${lines.length > OUTLINE_MAX_ITEMS ? `\n…and ${lines.length - OUTLINE_MAX_ITEMS} more` : ""}` : "";
  const text = [section("Boxes", boxLines), section("Connections", links), section("Other text", freeText)].filter(Boolean).join("\n\n");
  return { text: text || "(empty drawing)", shapes: shapes.length, connections: links.length };
}
