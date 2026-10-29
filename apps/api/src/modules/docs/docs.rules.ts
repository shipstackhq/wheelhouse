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
