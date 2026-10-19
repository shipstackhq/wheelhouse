/**
 * The header search's data side (WH-109). `useGlobalSearch(query, scope)` is all the panel knows: each kind loads on its own, so a slow or
 * failing kind never holds up the others, and the previous answer stays on screen while the next one loads. Phase 1 feeds it from a
 * mock provider; phase 2 swaps `provider` for the real endpoint and nothing in the components changes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SearchGroup, SearchHit, SearchKind } from "@wheelhouse/api-client";

export const KINDS: SearchKind[] = ["ticket", "doc", "node", "decision", "term"];
export const KIND_LABEL: Record<SearchKind, string> = { ticket: "Tickets", doc: "Docs", node: "Map", decision: "Decisions", term: "Glossary" };
export type Scope = "project" | "all";
export type SearchProvider = (kind: SearchKind, query: string, scope: Scope, projectKey: string, signal: AbortSignal) => Promise<SearchGroup>;

export type GroupState = { kind: SearchKind; status: "loading" | "ready" | "error"; total: number; hits: SearchHit[]; error?: string };
export type GlobalSearch = {
  groups: GroupState[];
  best: SearchHit[];
  /** A new query is loading; what is shown is still the last answer. */
  stale: boolean;
  /** Every kind has answered (or failed). */
  settled: boolean;
  total: number;
  retry: (kind: SearchKind) => void;
};

const BEST = 5;
/** Smallest query worth sending, except a ticket or ADR ref. */
export const MIN_CHARS = 2;
export const isRefLike = (q: string) => /^(#?\d+|[a-z][a-z0-9]{0,11}-?\d+|adr-?\d+)$/i.test(q.trim());
export const worthSearching = (q: string) => q.trim().length >= MIN_CHARS || isRefLike(q);

/** The top hits across every kind, best score first. */
export function bestOf(groups: Pick<GroupState, "hits">[]): SearchHit[] {
  return groups
    .flatMap((g) => g.hits)
    .sort((a, b) => b.score - a.score)
    .slice(0, BEST);
}

/** Split `text` into plain and highlighted runs from [start, end) ranges (out-of-range and overlapping ranges are tolerated). */
export function highlight(text: string, marks: [number, number][] = []): { text: string; mark: boolean }[] {
  const ranges = marks
    .map(([s, e]) => [Math.max(0, s), Math.min(text.length, e)] as [number, number])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const out: { text: string; mark: boolean }[] = [];
  let at = 0;
  for (const [s, e] of ranges) {
    if (e <= at) continue;
    const from = Math.max(s, at);
    if (from > at) out.push({ text: text.slice(at, from), mark: false });
    out.push({ text: text.slice(from, e), mark: true });
    at = e;
  }
  if (at < text.length) out.push({ text: text.slice(at), mark: false });
  return out.length ? out : [{ text, mark: false }];
}

/** Where each of the query's words occurs in `text`, as highlight ranges. */
export function marksFor(text: string, query: string): [number, number][] {
  const out: [number, number][] = [];
  const lower = text.toLowerCase();
  for (const word of query.toLowerCase().split(/\s+/).filter((w) => w.length > 0)) {
    for (let i = lower.indexOf(word); i >= 0; i = lower.indexOf(word, i + word.length)) out.push([i, i + word.length]);
  }
  return out;
}

// ---- mock provider (phase 1) ------------------------------------------------------------------------------------------------------

type Seed = { id: string; title: string; snippet: string; meta: Record<string, string | number | null>; path: string };
const SEEDS: Record<SearchKind, Seed[]> = {
  ticket: [
    { id: "t87", title: "EPIC: Migrate to NestJS + React", snippet: "Feature freeze; schema and API contract frozen while the web app moves over.", meta: { ref: "WH-87", column: "In Progress", priority: "urgent" }, path: "?t=WH-87" },
    { id: "t66", title: "One search across tickets, comments, docs, decisions, map and glossary", snippet: "UI and agents share one query parser and one ranking function.", meta: { ref: "WH-66", column: "Todo", priority: "high" }, path: "?t=WH-66" },
    { id: "t37", title: "Agent memory: recall tool (search across board + map)", snippet: "Any agent can ask Wheelhouse what it knows and get the relevant slice.", meta: { ref: "WH-37", column: "Todo", priority: "high" }, path: "?t=WH-37" },
    { id: "t24", title: "Ticket dependencies (blocked by) and warnings when work overlaps", snippet: "Show what blocks a ticket and warn when two agents touch the same files.", meta: { ref: "WH-24", column: "Todo", priority: "high" }, path: "?t=WH-24" },
  ],
  doc: [
    { id: "d1", title: "Runbook: deploying the API", snippet: "One image, one port, one origin. Roll back by redeploying the previous tag.", meta: { path: "ops/runbook", updatedAt: "2026-10-12" }, path: "/docs/d1" },
    { id: "d2", title: "Memory layer design notes", snippet: "How agents remember and recall: notes with supersession, searched with the map.", meta: { path: "design/memory", updatedAt: "2026-10-02" }, path: "/docs/d2" },
    { id: "d3", title: "UI API conventions", snippet: "The error envelope, the CSRF token and optimistic version checks.", meta: { path: "engineering/ui-api", updatedAt: "2026-09-28" }, path: "/docs/d3" },
  ],
  node: [
    { id: "n1", title: "Memory layer", snippet: "Remember and recall for agents, reading and writing through the service layer.", meta: { layer: "system", kind: "service" }, path: "/map?node=n1" },
    { id: "n2", title: "Service layer", snippet: "Every read and write goes through here; access checks live in it.", meta: { layer: "system", kind: "module" }, path: "/map?node=n2" },
    { id: "n3", title: "service.ts", snippet: "packages/core/src/lib/service.ts: the service layer's code.", meta: { layer: "code", kind: "file" }, path: "/map?node=n3" },
  ],
  decision: [
    { id: "a16", title: "Migrate from Next.js to NestJS + React under a feature freeze", snippet: "The database schema and API contract stay frozen during the move.", meta: { number: 16, status: "accepted" }, path: "/decisions/16" },
    { id: "a23", title: "Access is members-only per project", snippet: "A person sees only the projects they belong to.", meta: { number: 23, status: "accepted" }, path: "/decisions/23" },
    { id: "a24", title: "The React app is served by the API process", snippet: "One image, one port, one origin.", meta: { number: 24, status: "accepted" }, path: "/decisions/24" },
  ],
  term: [
    { id: "g1", title: "Agent", snippet: "A Claude instance acting through an API key.", meta: { term: "Agent" }, path: "/glossary/g1" },
    { id: "g2", title: "Briefing", snippet: "The compact project context an agent loads at the start of a session.", meta: { term: "Briefing" }, path: "/glossary/g2" },
    { id: "g3", title: "Stale node", snippet: "A map node whose code changed since it was described.", meta: { term: "Stale node" }, path: "/glossary/g3" },
  ],
};

/** Dev switch: `localStorage.wh_search_mock` = "loading" | "error" | "error:doc" | "empty" | "slow" forces a state in the mock. */
export function mockMode(): string {
  try {
    return localStorage.getItem("wh_search_mock") ?? "";
  } catch {
    return "";
  }
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), reject(new DOMException("aborted", "AbortError"))), { once: true });
  });

export const mockProvider: SearchProvider = async (kind, query, scope, projectKey, signal) => {
  const mode = mockMode();
  const index = KINDS.indexOf(kind);
  await wait(mode === "slow" ? 1500 : 60 + index * 70, signal);
  if (mode === "loading") await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
  if (mode === "error" || mode === `error:${kind === "node" ? "map" : kind}`) throw new Error("mock failure");
  const q = query.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const matches = mode === "empty" ? [] : SEEDS[kind].filter((s) => words.every((w) => `${s.title} ${s.snippet} ${Object.values(s.meta).join(" ")}`.toLowerCase().includes(w)));
  const hits: SearchHit[] = matches.map((s, i) => ({
    kind,
    id: s.id,
    projectKey: scope === "all" && i % 2 ? "BB" : projectKey,
    title: s.title,
    snippet: s.snippet,
    marks: marksFor(s.title, query),
    snippetMarks: marksFor(s.snippet, query),
    meta: s.meta,
    href: `/p/${scope === "all" && i % 2 ? "BB" : projectKey}${s.path}`,
    score: 1 - i * 0.1 - index * 0.01,
  }));
  return { kind, total: hits.length, hits };
};

// ---- the hook -----------------------------------------------------------------------------------------------------------------------

const idle = (): GroupState[] => KINDS.map((kind) => ({ kind, status: "ready", total: 0, hits: [] }));

export function useGlobalSearch(query: string, scope: Scope, projectKey: string, provider: SearchProvider = mockProvider, debounceMs = 120): GlobalSearch {
  const [groups, setGroups] = useState<GroupState[]>(idle);
  const [pending, setPending] = useState(0);
  const [again, setAgain] = useState<{ kind: SearchKind; n: number } | null>(null);
  const live = useRef(new Map<SearchKind, AbortController>());
  const active = worthSearching(query);
  const q = query.trim();

  const run = useCallback(
    (kind: SearchKind) => {
      live.current.get(kind)?.abort();
      const ctl = new AbortController();
      live.current.set(kind, ctl);
      setPending((n) => n + 1);
      provider(kind, q, scope, projectKey, ctl.signal)
        .then((g) => setGroups((cur) => cur.map((c) => (c.kind === kind ? { kind, status: "ready", total: g.total, hits: g.hits } : c))))
        .catch((e: unknown) => {
          if (ctl.signal.aborted) return;
          const error = e instanceof Error ? e.message : "failed";
          setGroups((cur) => cur.map((c) => (c.kind === kind ? { kind, status: "error", total: 0, hits: [], error } : c)));
        })
        .finally(() => setPending((n) => n - 1));
    },
    [provider, q, scope, projectKey],
  );

  useEffect(() => {
    const ctls = live.current;
    if (!active) {
      for (const c of ctls.values()) c.abort();
      setGroups(idle());
      return;
    }
    // A kind that has nothing yet shows its skeleton; one that had results keeps them (dimmed) until the new answer lands.
    setGroups((cur) => cur.map((c) => (c.hits.length || c.status === "loading" ? c : { ...c, status: "loading", error: undefined })));
    const t = setTimeout(() => KINDS.forEach(run), debounceMs);
    return () => {
      clearTimeout(t);
      for (const c of ctls.values()) c.abort();
    };
  }, [active, run, debounceMs]);

  useEffect(() => {
    if (again) run(again.kind);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new retry request runs it
  }, [again]);

  const retry = useCallback((kind: SearchKind) => {
    setGroups((cur) => cur.map((c) => (c.kind === kind ? { ...c, status: "loading", error: undefined } : c)));
    setAgain((a) => ({ kind, n: (a?.n ?? 0) + 1 }));
  }, []);

  const best = useMemo(() => bestOf(groups), [groups]);
  const total = groups.reduce((n, g) => n + g.total, 0);
  const settled = groups.every((g) => g.status !== "loading");
  return { groups, best, stale: active && (pending > 0 || !settled), settled, total, retry };
}
