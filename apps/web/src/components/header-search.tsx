/**
 * The header search (WH-109): a pill input that opens a results panel under it, across tickets, docs, map nodes, decisions and the
 * glossary. Phase 1 runs on mock data (`lib/search.ts`); the component only knows `useGlobalSearch`, so the real endpoint swaps in there.
 */
import clsx from "clsx";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import type { SearchHit, SearchKind } from "@wheelhouse/api-client";
import { CloseIcon, DecisionsIcon, FileIcon, ActivityIcon, NodeIcon, SearchIcon, TermIcon, TicketIcon, WarningIcon } from "./icons";
import { highlight, KIND_LABEL, KINDS, useGlobalSearch, worthSearching, type GroupState, type Scope, type SearchProvider } from "../lib/search";

const KIND_ICON = { ticket: TicketIcon, doc: FileIcon, node: NodeIcon, decision: DecisionsIcon, term: TermIcon } as const;
const RECENT_KEY = "wh_search_recent";
const OPENED_KEY = "wh_search_opened";
const PREVIEW = 5;

type Opened = { kind: SearchKind; title: string; href: string };
function read<T>(key: string): T[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* no storage: the panel just forgets */
  }
}

/** Whether a key press happened in something the person types into. */
/** The bar is shown from the sm breakpoint up; below it the search is a full-width sheet. */
const isDesktop = () => window.matchMedia?.("(min-width: 640px)").matches ?? true;

const inTextField = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

function Marked({ text, marks }: { text: string; marks?: [number, number][] }) {
  return (
    <>
      {highlight(text, marks).map((r, i) =>
        r.mark ? (
          <mark key={i} className="rounded-sm bg-accent/20 px-0.5 text-fg">
            {r.text}
          </mark>
        ) : (
          <span key={i}>{r.text}</span>
        ),
      )}
    </>
  );
}

/** The one line under a title: what the thing is, in the words its kind uses. */
export function metaLine(h: SearchHit, withProject: boolean): string {
  const m = h.meta;
  const parts =
    h.kind === "ticket"
      ? [m.ref, m.column, m.priority]
      : h.kind === "doc"
        ? [m.path, m.updatedAt && `updated ${m.updatedAt}`]
        : h.kind === "node"
          ? [m.layer, m.kind]
          : h.kind === "decision"
            ? [`ADR-${m.number}`, m.status]
            : ["Glossary", m.term];
  if (withProject) parts.unshift(h.projectKey);
  return parts.filter(Boolean).join(" · ");
}

type Row = { id: string; hit: SearchHit };

export function HeaderSearch({ projectKey, provider, onCreateTicket }: { projectKey: string; provider?: SearchProvider; onCreateTicket?: (title: string) => void | Promise<void> }) {
  const uid = useId();
  const listId = `${uid}-list`;
  const reduced = useReducedMotion();
  const navigate = useNavigate();
  const location = useLocation();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [scope, setScope] = useState<Scope>("project");
  const [filter, setFilter] = useState<"all" | SearchKind>("all");
  const [expanded, setExpanded] = useState<Set<SearchKind>>(new Set());
  const [active, setActive] = useState(0);
  const [intro, setIntro] = useState(false);
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const [recent, setRecent] = useState<string[]>(() => read<string>(RECENT_KEY));
  const [opened, setOpened] = useState<Opened[]>(() => read<Opened>(OPENED_KEY));
  const [creating, setCreating] = useState<"idle" | "busy" | "failed">("idle");

  const search = useGlobalSearch(query, scope, projectKey, provider);
  const searching = worthSearching(query);

  const close = useCallback((focus = true) => {
    setOpen(false);
    setSheet(false);
    if (focus) input.current?.focus();
  }, []);
  // "Create a ticket titled …": the caller makes the ticket (and usually opens it); a failure stays here, with the query intact.
  const createTicket = async (title: string) => {
    if (!onCreateTicket || creating === "busy") return;
    setCreating("busy");
    try {
      await onCreateTicket(title);
      setCreating("idle");
      close(false);
    } catch {
      setCreating("failed");
    }
  };
  const openPanel = useCallback(() => {
    setOpen((was) => {
      if (!was) {
        setIntro(true);
        setTimeout(() => setIntro(false), 600);
      }
      return true;
    });
  }, []);

  // `/` and ⌘/ focus the search from anywhere; `/` is left alone inside a text field.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const slash = e.key === "/" && !e.altKey;
      if (!slash) return;
      if (e.metaKey || e.ctrlKey || !inTextField(e.target)) {
        e.preventDefault();
        setSheet(!isDesktop());
        openPanel();
        // The sheet and the bar are the same input; wait for it to be shown.
        requestAnimationFrame(() => input.current?.focus());
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openPanel]);

  // Click outside closes; so does going to another page.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, close]);
  const here = location.pathname + location.search;
  const lastHere = useRef(here);
  useEffect(() => {
    if (lastHere.current !== here) {
      lastHere.current = here;
      setOpen(false);
      setSheet(false);
    }
  }, [here]);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  // What is shown, top to bottom: the best matches, then each kind. This order is also the arrow-key order.
  const sections = useMemo(() => {
    const kinds: GroupState[] = filter === "all" ? search.groups : search.groups.filter((g) => g.kind === filter);
    const rowsOf = (name: string, hits: SearchHit[]): Row[] => hits.map((hit) => ({ id: `${uid}-${name}-${hit.kind}-${hit.id}`, hit }));
    const best = filter === "all" && search.best.length ? rowsOf("best", search.best) : [];
    const groups = kinds.map((g) => {
      const all = filter !== "all" || expanded.has(g.kind);
      return { group: g, rows: rowsOf(g.kind, all ? g.hits : g.hits.slice(0, PREVIEW)) };
    });
    return { best, groups };
  }, [search.groups, search.best, filter, expanded, uid]);
  const rows = useMemo(() => [...sections.best, ...sections.groups.flatMap((s) => s.rows)], [sections]);
  const activeRow = rows[Math.min(active, rows.length - 1)];
  useEffect(() => setActive(0), [query, filter, scope]);
  useEffect(() => {
    if (activeRow) document.getElementById(activeRow.id)?.scrollIntoView?.({ block: "nearest" });
  }, [activeRow]);

  const remember = (q: string) => {
    const t = q.trim();
    if (!t) return;
    const next = [t, ...recent.filter((r) => r !== t)].slice(0, 8);
    setRecent(next);
    write(RECENT_KEY, next);
  };
  const go = (hit: SearchHit, newTab: boolean) => {
    remember(query);
    const next = [{ kind: hit.kind, title: hit.title, href: hit.href }, ...opened.filter((o) => o.href !== hit.href)].slice(0, 5);
    setOpened(next);
    write(OPENED_KEY, next);
    if (newTab) {
      window.open(hit.href, "_blank", "noopener");
      return;
    }
    close(false);
    void navigate(hit.href);
  };

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (query) setQuery("");
      else close();
      return;
    }
    if (!open) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        openPanel();
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length) setActive((i) => (e.key === "ArrowDown" ? (i + 1) % rows.length : (i - 1 + rows.length) % rows.length));
    } else if ((e.key === "Home" || e.key === "End") && rows.length && searching) {
      e.preventDefault();
      setActive(e.key === "Home" ? 0 : rows.length - 1);
    } else if (e.key === "Enter" && searching && activeRow) {
      e.preventDefault();
      go(activeRow.hit, e.metaKey || e.ctrlKey);
    }
  };

  const chipKeys = ["all", ...KINDS] as const;
  const onChipKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = chipKeys[(i + (e.key === "ArrowRight" ? 1 : chipKeys.length - 1)) % chipKeys.length];
    setFilter(next);
    document.getElementById(`${uid}-chip-${next}`)?.focus();
  };

  const countOf = (k: "all" | SearchKind) => (k === "all" ? search.total : (search.groups.find((g) => g.kind === k)?.total ?? 0));
  const failed = search.groups.filter((g) => g.status === "error");
  const anyLoading = search.groups.some((g) => g.status === "loading");
  const noResults = searching && search.settled && search.total === 0 && failed.length === 0;
  const withProject = scope === "all";

  const renderRow = (r: Row, i: number): ReactNode => {
    const Icon = KIND_ICON[r.hit.kind];
    const selected = activeRow?.id === r.id;
    return (
      <motion.li
        key={r.id}
        id={r.id}
        role="option"
        aria-selected={selected}
        initial={intro ? { opacity: 0, y: reduced ? 0 : 4 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.12, delay: intro ? Math.min(i, 8) * 0.015 : 0 }}
        onMouseMove={() => rows[active]?.id !== r.id && setActive(rows.findIndex((x) => x.id === r.id))}
        onClick={(e) => go(r.hit, e.metaKey || e.ctrlKey)}
        className={clsx("flex cursor-pointer gap-3 rounded-lg px-3 py-2", selected ? "bg-panel-2" : "hover:bg-panel-2/60")}
      >
        <Icon className="mt-0.5 text-base text-muted" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            <Marked text={r.hit.title} marks={r.hit.marks} />
          </div>
          <div className="truncate text-xs text-muted">{metaLine(r.hit, withProject)}</div>
          {r.hit.snippet && (
            <div className="line-clamp-2 text-xs text-muted/90">
              <Marked text={r.hit.snippet} marks={r.hit.snippetMarks} />
            </div>
          )}
        </div>
      </motion.li>
    );
  };

  const heading = (text: string, extra?: ReactNode) => (
    <div className="flex items-center justify-between px-3 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-muted">
      <span>{text}</span>
      {extra}
    </div>
  );

  const body = !searching ? (
    <div className="space-y-4 p-3 text-sm">
      {recent.length > 0 && (
        <div>
          <div className="mb-1 flex items-center justify-between text-xs font-medium uppercase tracking-wide text-muted">
            <span>Recent searches</span>
            <button
              type="button"
              className="normal-case tracking-normal hover:text-fg"
              onClick={() => {
                setRecent([]);
                write(RECENT_KEY, []);
              }}
            >
              Clear
            </button>
          </div>
          <ul className="flex flex-wrap gap-1.5">
            {recent.map((r) => (
              <li key={r}>
                <button type="button" className="inline-flex items-center gap-1 rounded-full border border-line bg-panel-2 px-2.5 py-1 text-xs hover:border-muted/60" onClick={() => (setQuery(r), input.current?.focus())}>
                  <ActivityIcon className="text-muted" />
                  {r}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {opened.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Recently opened</div>
          <ul>
            {opened.map((o) => {
              const Icon = KIND_ICON[o.kind];
              return (
                <li key={o.href}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-panel-2"
                    onClick={() => {
                      close(false);
                      void navigate(o.href);
                    }}
                  >
                    <Icon className="text-muted" />
                    <span className="truncate">{o.title}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <p className="text-xs text-muted">
        Try <code className="rounded bg-panel-2 px-1">WH-87</code>, <code className="rounded bg-panel-2 px-1">label:bug</code> or <code className="rounded bg-panel-2 px-1">doc:runbook</code>. Press <kbd className="rounded border border-line px-1">/</kbd> to search from anywhere.
      </p>
    </div>
  ) : noResults ? (
    <div className="space-y-2 p-6 text-center text-sm">
      <p className="font-medium">No results for “{query.trim()}”</p>
      <p className="text-xs text-muted">
        {filter !== "all" && "Try All instead of one kind. "}
        {scope === "project" && "Try All my projects. "}Check the spelling or use fewer words.
      </p>
      {onCreateTicket && (
        <button type="button" className="btn" disabled={creating === "busy"} onClick={() => void createTicket(query.trim())}>
          {creating === "busy" ? "Creating…" : `Create a ticket titled “${query.trim()}”`}
        </button>
      )}
      {creating === "failed" && (
        <p role="alert" className="text-xs text-danger">
          {"Couldn't create the ticket. Check your connection and try again."}
        </p>
      )}
    </div>
  ) : (
    <div className={clsx("pb-2 transition-opacity", search.stale && "opacity-60")} aria-busy={search.stale}>
      {!online && (
        <p role="note" className="mx-3 mt-2 flex items-center gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs">
          <WarningIcon /> You are offline. Results will load when you are back.
        </p>
      )}
      {sections.best.length > 0 && (
        <section role="group" aria-label="Best matches">
          {heading("Best matches")}
          <ul role="presentation">{sections.best.map((r, i) => renderRow(r, i))}</ul>
        </section>
      )}
      {sections.groups.map(({ group, rows: groupRows }) => {
        const offset = sections.best.length + sections.groups.slice(0, sections.groups.findIndex((s) => s.group.kind === group.kind)).reduce((n, s) => n + s.rows.length, 0);
        if (group.status === "ready" && group.total === 0) return null;
        return (
          <section key={group.kind} role="group" aria-label={KIND_LABEL[group.kind]}>
            {heading(
              KIND_LABEL[group.kind],
              group.status === "ready" && (
                <span className="flex items-center gap-2 normal-case tracking-normal">
                  {group.total}
                  {filter === "all" && group.total > PREVIEW && !expanded.has(group.kind) && (
                    <button type="button" className="text-accent hover:underline" onClick={() => setExpanded(new Set(expanded).add(group.kind))}>
                      Show all {group.total}
                    </button>
                  )}
                </span>
              ),
            )}
            {group.status === "error" ? (
              <p className="flex items-center gap-2 px-3 py-2 text-xs text-danger">
                <WarningIcon /> Couldn&apos;t load {KIND_LABEL[group.kind].toLowerCase()}.
                <button type="button" className="text-accent hover:underline" onClick={() => search.retry(group.kind)}>
                  Retry
                </button>
              </p>
            ) : group.status === "loading" && groupRows.length === 0 ? (
              <div aria-hidden className="space-y-2 px-3 py-2" data-testid={`skeleton-${group.kind}`}>
                <div className="h-3 w-2/3 rounded bg-panel-2 motion-safe:animate-pulse" />
                <div className="h-3 w-1/2 rounded bg-panel-2 motion-safe:animate-pulse" />
              </div>
            ) : (
              <ul role="presentation">{groupRows.map((r, i) => renderRow(r, offset + i))}</ul>
            )}
          </section>
        );
      })}
      {!anyLoading && search.total === 0 && failed.length > 0 && <p className="px-3 py-2 text-xs text-muted">Some results could not be loaded.</p>}
    </div>
  );

  const showPanel = open;
  return (
    <>
      <button type="button" className="btn btn-ghost !px-2 sm:hidden" aria-label="Search" onClick={() => (setSheet(true), openPanel(), requestAnimationFrame(() => input.current?.focus()))}>
        <SearchIcon className="text-base" />
      </button>
      <div
        ref={root}
        className={clsx(
          sheet ? "fixed inset-x-0 top-0 z-50 block bg-panel p-3 shadow-lg" : "relative mx-auto hidden w-full sm:block",
          !sheet && "transition-[max-width] duration-150 motion-reduce:transition-none",
          !sheet && (open ? "max-w-xl" : "max-w-md"),
        )}
        onBlur={(e) => {
          if (!query && !root.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
        }}
      >
        <div className="relative">
          <input
            ref={input}
            type="search"
            role="combobox"
            aria-expanded={showPanel}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={showPanel && searching ? activeRow?.id : undefined}
            aria-label="Search docs, tickets, notes"
            placeholder="Search docs, tickets, notes"
            autoComplete="off"
            value={query}
            className="input !rounded-full !border-line !bg-panel-2 !py-1.5 !pl-9 !pr-9 text-sm focus:!border-accent [&::-webkit-search-cancel-button]:hidden"
            onFocus={openPanel}
            onClick={openPanel}
            onChange={(e) => (setQuery(e.target.value.slice(0, 200)), openPanel())}
            onKeyDown={onInputKey}
          />
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-base text-muted" />
          {(sheet || query) && (
            <button type="button" tabIndex={-1} aria-label={query ? "Clear search" : "Close search"} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted hover:text-fg" onClick={() => (query ? (setQuery(""), input.current?.focus()) : close())}>
              <CloseIcon />
            </button>
          )}
        </div>
        <div role="status" aria-live="polite" className="sr-only">
          {searching && search.settled ? `${search.total} ${search.total === 1 ? "result" : "results"}` : ""}
        </div>
        <AnimatePresence>
          {showPanel && (
            <motion.div
              key="panel"
              initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
              animate={reduced ? { opacity: 1 } : { opacity: 1, height: "auto" }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
              className={clsx("overflow-hidden rounded-xl border border-line bg-panel shadow-xl", sheet ? "mt-2 w-full" : "absolute left-1/2 top-full z-40 mt-2 w-[min(760px,calc(100vw-2rem))] -translate-x-1/2")}
            >
              <div className={clsx("flex flex-col", sheet ? "max-h-[calc(100dvh-6rem)]" : "max-h-[70vh]")}>
                <motion.div layout className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2" role="toolbar" aria-label="Filter results">
                  {chipKeys.map((k, i) => {
                    const on = filter === k;
                    return (
                      <button
                        key={k}
                        id={`${uid}-chip-${k}`}
                        type="button"
                        aria-pressed={on}
                        tabIndex={on ? 0 : -1}
                        className={clsx("rounded-full border px-2.5 py-1 text-xs", on ? "border-accent bg-accent/10 text-fg" : "border-line text-muted hover:text-fg")}
                        onClick={() => setFilter(k)}
                        onKeyDown={(e) => onChipKey(e, i)}
                      >
                        {k === "all" ? "All" : KIND_LABEL[k]}
                        {searching && <span className="ml-1 tabular-nums text-muted">{countOf(k)}</span>}
                      </button>
                    );
                  })}
                  <div className="ml-auto flex rounded-full border border-line p-0.5 text-xs" role="group" aria-label="Scope">
                    {(["project", "all"] as const).map((s) => (
                      <button key={s} type="button" aria-pressed={scope === s} className={clsx("rounded-full px-2 py-0.5", scope === s ? "bg-panel-2 text-fg" : "text-muted hover:text-fg")} onClick={() => setScope(s)}>
                        {s === "project" ? "This project" : "All my projects"}
                      </button>
                    ))}
                  </div>
                </motion.div>
                <div id={listId} role="listbox" aria-label="Search results" className="min-h-0 overflow-y-auto overscroll-contain">
                  {body}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  );
}
