"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import clsx from "clsx";
import { Dialog } from "radix-ui";
import {
  browseRepoTreeAction,
  createDocAction,
  createTicketFromActionItemAction,
  deleteDocAction,
  getDocAction,
  linkDocNodeAction,
  listDocsAction,
  listRepositoriesAction,
  markDocFreshAction,
  moveDocAction,
  suggestDocAnchorsAction,
  updateDocAction,
  upsertDecisionAction,
} from "@/app/actions";
import { Select, useDialogs } from "@/components/ui";
import { DescriptionEditor } from "@/components/description-editor";
import { DOC_TEMPLATES, extractActionItems, type DocTemplateId } from "@wheelhouse/core/lib/doc-templates";

type TreeDoc = { id: string; parentId: string | null; slug: string; title: string; version: number; position: number; updatedAt: string | Date; stale?: boolean };
type NodeLite = { id: string; name: string; layer: string; parentId: string | null };
type DecisionLite = { id: string; number: number; title: string };
type MemberLite = { id: string; name: string };
type RepoLite = { id: string; displayName: string; provider: string; githubInstallationId: string | null; githubRepoId: string | null };
type DocDetail = {
  doc: TreeDoc & {
    body: string;
    anchors: string[];
    stale: boolean;
    staleReason: string | null;
    updatedByKind: "human" | "agent";
    updatedById: string | null;
    createdAt: string | Date;
  };
  nodes: { id: string; name: string; kind: string; layer: string }[];
};

/** Rough reading time from word count, Confluence-style ("12 min"). ~200 wpm, minimum 1. */
function readTime(body: string): number {
  const words = body.trim() ? body.trim().split(/\s+/).length : 0;
  return Math.max(1, Math.round(words / 200));
}

/**
 * `/p/[key]/docs`: a tree on the left (parent/child via `parentId`, same pattern as the
 * map), a Markdown editor with live preview on the right (raw HTML stays disabled — react-markdown
 * only renders what remark-gfm produces). Version conflicts surface the same way the ticket
 * dialog does: a stale-version banner plus a refused save that never overwrites a concurrent edit.
 */
export function DocsExplorer(props: { projectKey: string; initialTree: TreeDoc[]; nodes: NodeLite[]; decisions?: DecisionLite[]; members?: MemberLite[] }) {
  const { projectKey, nodes, decisions = [], members = [] } = props;
  const router = useRouter();
  const [tree, setTree] = useState<TreeDoc[]>(props.initialTree);
  const [selectedId, setSelectedId] = useState<string | null>(props.initialTree[0]?.id ?? null);
  const [detail, setDetail] = useState<DocDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [bodyBase, setBodyBase] = useState(0);
  const [anchors, setAnchors] = useState<string[]>([]);
  const [newAnchor, setNewAnchor] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copyLabel, setCopyLabel] = useState("Copy for agent");
  // WH-65: which template (if any) the currently-edited doc was created from, so we know
  // whether to show the "Link or create ADR" affordance (decision-record template only).
  const [docTemplateId, setDocTemplateId] = useState<DocTemplateId | null>(null);
  const [showTemplatePicker, setShowTemplatePicker] = useState<{ parentId: string | null } | null>(null);
  const [actionItemBusy, setActionItemBusy] = useState<number | null>(null);
  const [treeFilter, setTreeFilter] = useState("");
  const [githubRepos, setGithubRepos] = useState<RepoLite[]>([]);
  const [showBrowseRepo, setShowBrowseRepo] = useState(false);
  const [browseRepoId, setBrowseRepoId] = useState<string>("");
  const [browseFiles, setBrowseFiles] = useState<string[] | null>(null);
  const [browseFilter, setBrowseFilter] = useState("");
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [browseBusy, setBrowseBusy] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const { confirm, dialogs } = useDialogs();

  useEffect(() => {
    void (async () => {
      const res = await listRepositoriesAction(projectKey);
      if (!res.ok) return;
      const repos = (res.data as RepoLite[]).filter((r) => r.provider === "github" && r.githubInstallationId && r.githubRepoId);
      setGithubRepos(repos);
      if (repos.length) setBrowseRepoId((id) => id || repos[0].id);
    })();
  }, [projectKey]);

  const refreshTree = useCallback(async () => {
    const res = await listDocsAction(projectKey);
    if (!res.ok) return setError(res.error);
    setTree(res.data as TreeDoc[]);
  }, [projectKey]);

  const load = useCallback(async (id: string) => {
    const res = await getDocAction(projectKey, id);
    if (!res.ok) return setError(res.error);
    setDetail(res.data as DocDetail);
    setError(null);
  }, [projectKey]);

  const selectDoc = useCallback((id: string | null) => {
    setDocTemplateId(null); // template is only known right after creating a doc in this session (see createWithTemplate)
    setSelectedId(id);
  }, []);

  useEffect(() => {
    if (selectedId) void load(selectedId);
    else setDetail(null);
  }, [selectedId, load]);

  // An empty doc goes straight into edit mode — there's nothing to preview, so showing the
  // editor directly (rather than an "Add content…" placeholder) is always what's wanted next.
  useEffect(() => {
    if (!detail || editing) return;
    if (detail.doc.body) return;
    setTitle(detail.doc.title);
    setBody("");
    setBodyBase(detail.doc.version);
    setAnchors(detail.doc.anchors);
    setSuggestions([]);
    setEditing(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail]);

  useEffect(() => {
    const on = () => {
      void refreshTree();
      if (selectedId) void load(selectedId);
    };
    window.addEventListener("wheelhouse:changed", on);
    return () => window.removeEventListener("wheelhouse:changed", on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const byParent = useMemo(() => {
    const m = new Map<string | null, TreeDoc[]>();
    for (const d of tree) {
      const arr = m.get(d.parentId) ?? [];
      arr.push(d);
      m.set(d.parentId, arr);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.position - b.position);
    return m;
  }, [tree]);

  const createNew = (parentId: string | null) => setShowTemplatePicker({ parentId });

  const createWithTemplate = async (templateId: DocTemplateId | null) => {
    const parentId = showTemplatePicker?.parentId ?? null;
    const t = templateId ? DOC_TEMPLATES.find((x) => x.id === templateId) : undefined;
    setBusy(true);
    try {
      const res = await createDocAction(projectKey, { title: t ? t.name : "Untitled doc", parent: parentId, template: templateId ?? undefined });
      if (!res.ok) return setError(res.error);
      await refreshTree();
      setSelectedId(res.data.id);
      setShowTemplatePicker(null);
      setDocTemplateId(templateId);
      const loaded = await getDocAction(projectKey, res.data.id);
      if (loaded.ok) {
        const dd = loaded.data as DocDetail;
        setDetail(dd);
        setTitle(dd.doc.title);
        setBody(dd.doc.body);
        setBodyBase(dd.doc.version);
        setAnchors(dd.doc.anchors);
        setSuggestions([]);
        setEditing(true); // still just an editable draft — nothing further is "saved" until Save is clicked
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const d = detail?.doc;
  const linkedIds = new Set((detail?.nodes ?? []).map((n) => n.id));
  const actionItems = useMemo(() => (d?.body ? extractActionItems(d.body) : []), [d?.body]);

  /**
   * One-click "Create ticket" for an unchecked action item (WH-65). We create the ticket in
   * the project's default column (Todo) with the item's text as title — one-shot, no
   * bidirectional sync — then check the box in the doc body so it isn't offered twice.
   * Nothing links the ticket back to the doc; re-open the ticket from the board if needed.
   */
  const createTicketFromActionItem = async (item: { text: string; line: number }) => {
    if (!d) return;
    setActionItemBusy(item.line);
    try {
      const res = await createTicketFromActionItemAction(projectKey, item.text);
      if (!res.ok) return setError(res.error);
      const lines = d.body.split("\n");
      lines[item.line] = lines[item.line].replace(/\[ \]/, "[x]");
      const newBody = lines.join("\n");
      const patchRes = await updateDocAction(projectKey, d.id, { body: newBody }, d.version);
      if (patchRes.ok) {
        await load(d.id);
        router.refresh();
      }
    } finally {
      setActionItemBusy(null);
    }
  };

  /** "Create ADR from this doc" (WH-65): seeds a new ADR from a decision-record doc's title/sections, reusing upsertDecision rather than building a separate editor. */
  const createAdrFromDoc = async () => {
    if (!d) return;
    setBusy(true);
    try {
      const section = (heading: string) => {
        const m = new RegExp(`^##\\s*${heading}\\s*$([\\s\\S]*?)(?=^##\\s|\\Z)`, "im").exec(d.body);
        return m ? m[1].trim() : "";
      };
      const res = await upsertDecisionAction(projectKey, {
        title: d.title,
        status: "proposed",
        context: section("Context"),
        decision: section("Decision"),
        consequences: section("Consequences"),
      });
      if (!res.ok) return setError(res.error);
      router.push(`/p/${projectKey}/decisions`);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!d) return false;
    setBusy(true);
    try {
      const patch: { title?: string; body?: string; anchors?: string[] } = {};
      if (title !== d.title) patch.title = title;
      if (body !== d.body) patch.body = body;
      if (JSON.stringify(anchors) !== JSON.stringify(d.anchors)) patch.anchors = anchors;
      if (!Object.keys(patch).length) {
        setEditing(false);
        return true;
      }
      const res = await updateDocAction(projectKey, d.id, patch, bodyBase);
      await load(d.id);
      await refreshTree();
      router.refresh();
      if (!res.ok) {
        setError(res.error ?? "Failed");
        return false;
      }
      setError(null);
      return true;
    } finally {
      setBusy(false);
    }
  };

  const confirmAccurate = async () => {
    if (!d) return;
    setBusy(true);
    try {
      const res = await markDocFreshAction(projectKey, d.id);
      if (!res.ok) return setError(res.error);
      await load(d.id);
      await refreshTree();
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const openBrowseRepo = async () => {
    setShowBrowseRepo(true);
    setBrowseError(null);
    setBrowseFilter("");
    if (!browseRepoId) return;
    setBrowseBusy(true);
    try {
      const res = await browseRepoTreeAction(projectKey, browseRepoId);
      if (!res.ok) return setBrowseError(res.error);
      setBrowseFiles((res.data as { files: { path: string }[] }).files.map((f) => f.path));
    } finally {
      setBrowseBusy(false);
    }
  };

  const addAnchorFromBrowse = (path: string) => {
    if (!anchors.includes(path)) setAnchors([...anchors, path]);
  };

  /** Build a nested directory tree from the flat list of file paths the GitHub API returns. */
  type FileTreeNode = { name: string; path: string; isFile: boolean; children: Map<string, FileTreeNode> };
  const buildFileTree = (paths: string[]): FileTreeNode => {
    const root: FileTreeNode = { name: "", path: "", isFile: false, children: new Map() };
    for (const full of paths) {
      const parts = full.split("/");
      let node = root;
      let acc = "";
      parts.forEach((part, i) => {
        acc = acc ? `${acc}/${part}` : part;
        const isFile = i === parts.length - 1;
        let next = node.children.get(part);
        if (!next) {
          next = { name: part, path: acc, isFile, children: new Map() };
          node.children.set(part, next);
        }
        node = next;
      });
    }
    return root;
  };

  const toggleDir = (path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  /** Recursively render a directory tree node; folders matching the filter (by any descendant file) auto-expand. */
  const renderFileTreeNode = (node: FileTreeNode, depth: number, filter: string): React.ReactNode => {
    const entries = [...node.children.values()].sort((a, b) => {
      if (a.isFile !== b.isFile) return a.isFile ? 1 : -1; // folders first
      return a.name.localeCompare(b.name);
    });
    return entries.map((child) => {
      if (child.isFile) {
        if (filter && !child.path.toLowerCase().includes(filter)) return null;
        return (
          <button
            key={child.path}
            type="button"
            className={clsx(
              "flex w-full items-center gap-1.5 truncate rounded px-2 py-1 text-left font-mono text-xs hover:bg-panel-2",
              anchors.includes(child.path) ? "text-accent" : "text-fg",
            )}
            style={{ paddingLeft: `${depth * 1.1 + 0.5}rem` }}
            title={child.path}
            onClick={() => addAnchorFromBrowse(child.path)}
          >
            <span aria-hidden>{anchors.includes(child.path) ? "✓" : "📄"}</span>
            <span className="truncate">{child.name}</span>
          </button>
        );
      }
      // A folder is shown (and auto-expanded while filtering) only if some descendant file matches.
      const matches = filter ? containsMatch(child, filter) : true;
      if (!matches) return null;
      const expanded = filter ? true : expandedDirs.has(child.path);
      return (
        <div key={child.path}>
          <button
            type="button"
            className="flex w-full items-center gap-1.5 truncate rounded px-2 py-1 text-left font-mono text-xs text-muted hover:bg-panel-2 hover:text-fg"
            style={{ paddingLeft: `${depth * 1.1 + 0.5}rem` }}
            onClick={() => toggleDir(child.path)}
          >
            <span aria-hidden className="w-3 shrink-0 text-[10px]">{expanded ? "▾" : "▸"}</span>
            <span aria-hidden>📁</span>
            <span className="truncate">{child.name}</span>
          </button>
          {expanded && renderFileTreeNode(child, depth + 1, filter)}
        </div>
      );
    });
  };

  const containsMatch = (node: FileTreeNode, filter: string): boolean => {
    for (const child of node.children.values()) {
      if (child.isFile) {
        if (child.path.toLowerCase().includes(filter)) return true;
      } else if (containsMatch(child, filter)) return true;
    }
    return false;
  };

  const loadSuggestions = async () => {
    if (!d) return;
    const res = await suggestDocAnchorsAction(projectKey, d.id);
    if (res.ok) setSuggestions(res.data as string[]);
  };

  const copyForAgent = async () => {
    if (!d) return;
    try {
      await navigator.clipboard.writeText(`@doc:${d.slug}`);
      setCopyLabel("Copied!");
      setTimeout(() => setCopyLabel("Copy for agent"), 1500);
    } catch {
      setError("Could not copy to clipboard");
    }
  };

  const filterTerm = treeFilter.trim().toLowerCase();
  // Doc-tree search (WH-82): when a search term is active we show a flat list of every doc whose title
  // matches (no need to match at every ancestor level — simpler than preserving nesting, and still
  // surfaces nested matches); with no term, the normal nested tree renders via renderNode below.
  const filteredFlat = filterTerm ? tree.filter((t) => t.title.toLowerCase().includes(filterTerm)).sort((a, b) => a.title.localeCompare(b.title)) : null;

  const docRow = (k: TreeDoc, depth: number) => {
    return (
      <li key={k.id} className="group/doc">
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => selectDoc(k.id)}
            className={clsx(
              "flex min-w-0 flex-1 items-center gap-1.5 truncate rounded-md px-2 py-1.5 text-left text-sm transition-colors",
              selectedId === k.id ? "bg-accent/10 font-medium text-accent" : "text-muted hover:bg-panel-2/70 hover:text-fg",
            )}
            title={k.title}
          >
            {k.stale && <span className="text-warn" title="Possibly out of date">⚠</span>}
            <span className="truncate">{k.title}</span>
          </button>
        </div>
        {!filterTerm && renderNode(k.id, depth + 1)}
      </li>
    );
  };

  const renderNode = (parentId: string | null, depth: number): React.ReactNode => {
    const kids = byParent.get(parentId) ?? [];
    if (!kids.length) return null;
    return (
      <ul className={depth === 0 ? "space-y-0.5" : "ml-3 space-y-0.5 border-l border-line pl-2"}>
        {kids.map((k) => docRow(k, depth))}
      </ul>
    );
  };

  const authorName = (kind: "human" | "agent", id: string | null) => {
    if (kind === "agent") return "Agent";
    return members.find((m) => m.id === id)?.name ?? "Someone";
  };
  const authorInitial = (kind: "human" | "agent", id: string | null) => (kind === "agent" ? "🤖" : (authorName(kind, id)[0] ?? "?").toUpperCase());

  return (
    <div className="confluence-docs grid h-full grid-cols-[18rem_1fr] overflow-hidden bg-bg">
      <aside className="flex min-h-0 flex-col overflow-y-auto border-r border-line/70 bg-panel/40 px-3 py-4">
        <div className="mb-3 flex items-center justify-between px-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted">Docs</span>
          <button className="rounded px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10" disabled={busy} onClick={() => void createNew(null)}>
            + Create
          </button>
        </div>
        {tree.length > 0 && (
          <div className="relative mb-2 px-0.5">
            <input
              type="search"
              className="input !rounded-full !border-transparent !bg-panel-2/70 !py-1.5 !pr-8 text-xs focus:!border-accent"
              placeholder="Search docs…"
              aria-label="Filter docs by title"
              value={treeFilter}
              onChange={(e) => setTreeFilter(e.target.value)}
            />
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-base text-muted">⌕</span>
          </div>
        )}
        {tree.length === 0 ? (
          <p className="px-2 py-4 text-sm text-muted">No docs yet. Create one to get started.</p>
        ) : filteredFlat ? (
          filteredFlat.length === 0 ? (
            <p className="px-2 py-4 text-sm text-muted">No docs match &quot;{treeFilter}&quot;.</p>
          ) : (
            <ul className="space-y-0.5">{filteredFlat.map((k) => docRow(k, 0))}</ul>
          )
        ) : (
          renderNode(null, 0)
        )}
      </aside>

      <section className="min-h-0 overflow-y-auto">
        {!d ? (
          <p className="p-6 text-sm text-muted">{error ?? "Select a doc, or create one."}</p>
        ) : (
          <div className="w-full space-y-5 py-10">
            {error && <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

            {d.stale && (
              <p role="status" className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
                ⚠ Possibly out of date{d.staleReason ? `: ${d.staleReason}` : ""}. Edit the content to refresh it, or confirm it&apos;s still accurate.
                <button className="ml-2 underline" disabled={busy} onClick={confirmAccurate}>
                  Confirm accurate
                </button>
              </p>
            )}

            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                {editing ? (
                  <input className="input !border-none !bg-transparent !px-0 !text-3xl !font-bold" value={title} onChange={(e) => setTitle(e.target.value)} />
                ) : (
                  <h1 className="truncate text-3xl font-bold tracking-tight">{d.title}</h1>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                {!editing ? (
                  <button
                    className="btn btn-primary"
                    onClick={() => {
                      setTitle(d.title);
                      setBody(d.body);
                      setBodyBase(d.version);
                      setAnchors(d.anchors);
                      setSuggestions([]);
                      setEditing(true);
                    }}
                  >
                    ✎ Edit
                  </button>
                ) : null}
                <button
                  className="btn btn-danger"
                  disabled={busy}
                  onClick={async () => {
                    if (!(await confirm({ title: `Delete "${d.title}"?`, description: "This also removes any nested docs underneath it.", confirmLabel: "Delete", danger: true }))) return;
                    setBusy(true);
                    try {
                      const res = await deleteDocAction(projectKey, d.id);
                      if (!res.ok) return setError(res.error);
                      setSelectedId(null);
                      await refreshTree();
                      router.refresh();
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Delete
                </button>
              </div>
            </div>

            {/* Confluence-style byline: author, freshness status, read time, word count, "copy for agent" */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-line/70 pb-4 text-xs text-muted">
              <span className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent/15 text-xs font-semibold text-accent" aria-hidden>
                  {authorInitial(d.updatedByKind, d.updatedById)}
                </span>
                By {authorName(d.updatedByKind, d.updatedById)}
              </span>
              <span className={clsx("flex items-center gap-1.5", d.stale ? "text-warn" : "text-ok")}>
                <span className="h-2 w-2 rounded-full bg-current" aria-hidden />
                {d.stale ? "Possibly out of date" : "Up to date"}
              </span>
              <span>📖 {readTime(d.body)} min read</span>
              <span>{d.body.trim() ? d.body.trim().split(/\s+/).length : 0} words</span>
              <button type="button" className="ml-auto text-xs text-accent hover:underline" onClick={copyForAgent}>
                {copyLabel}
              </button>
              <span className="text-xs text-muted/70">
                {d.slug} · v{d.version}
              </span>
            </div>

            {editing ? (
              <div className="space-y-2">
                {d.version !== bodyBase && (
                  <p role="status" className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
                    This doc changed while you were editing (now v{d.version}). Saving will be refused so nothing is overwritten: copy your
                    text, cancel, and apply it to the latest version.
                  </p>
                )}
                <DescriptionEditor value={body} onChange={setBody} size="full" />
                <section className="rounded-lg border border-line/70 bg-panel/40 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-fg">Attached files</span>
                    <div className="flex items-center gap-3">
                      {githubRepos.length > 0 && (
                        <button type="button" className="btn btn-ghost flex items-center gap-1.5 px-2 py-1 text-xs" onClick={() => void openBrowseRepo()}>
                          <span className="text-sm" aria-hidden>⌕</span>
                          Browse repo…
                        </button>
                      )}
                      <button type="button" className="text-xs text-accent hover:underline" onClick={loadSuggestions}>
                        Suggest
                      </button>
                    </div>
                  </div>
                  <p className="mt-1 text-xs text-muted">File paths or globs this doc describes — flagged when the code changes.</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {anchors.map((a) => (
                      <span key={a} className="chip gap-1 bg-panel-2 py-1 font-mono text-xs">
                        {a}
                        <button
                          className="text-muted hover:text-fg"
                          aria-label={`Remove anchor ${a}`}
                          onClick={() => setAnchors(anchors.filter((x) => x !== a))}
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                    <input
                      className="input !w-40 !py-0.5 font-mono text-xs"
                      placeholder="src/lib/x.ts"
                      value={newAnchor}
                      onChange={(e) => setNewAnchor(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter" || !newAnchor.trim()) return;
                        e.preventDefault();
                        if (!anchors.includes(newAnchor.trim())) setAnchors([...anchors, newAnchor.trim()]);
                        setNewAnchor("");
                      }}
                    />
                  </div>
                  {suggestions.filter((s) => !anchors.includes(s)).length > 0 && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                      <span>Suggested:</span>
                      {suggestions
                        .filter((s) => !anchors.includes(s))
                        .map((s) => (
                          <button
                            key={s}
                            type="button"
                            className="chip gap-1 border border-dashed border-line bg-transparent py-0.5 font-mono text-accent hover:bg-accent/10"
                            onClick={() => setAnchors([...anchors, s])}
                          >
                            + {s}
                          </button>
                        ))}
                    </div>
                  )}
                </section>
                <div className="flex gap-2">
                  <button className="btn btn-primary" disabled={busy} onClick={async () => { if (await save()) setEditing(false); }}>
                    Save
                  </button>
                  <button className="btn" onClick={() => setEditing(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : d.body ? (
              <div className="md md-quiet rounded-lg bg-panel/40 p-6">
                <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
                  {d.body}
                </ReactMarkdown>
              </div>
            ) : null}

            {!editing && (
              <div className="space-y-4 rounded-lg border border-line/70 bg-panel/30 p-4">
                {actionItems.length > 0 && (
                  <section>
                    <span className="label">Action items</span>
                    <ul className="space-y-1">
                      {actionItems.map((item) => (
                        <li key={item.line} className="flex items-center justify-between gap-2 rounded-md border border-line bg-bg/50 px-3 py-1.5 text-sm">
                          <span>{item.text}</span>
                          <button
                            className="btn btn-ghost shrink-0 px-2 py-1 text-xs"
                            disabled={actionItemBusy === item.line}
                            onClick={() => void createTicketFromActionItem(item)}
                          >
                            {actionItemBusy === item.line ? "Creating…" : "Create ticket"}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                {docTemplateId === "decision-record" && (
                  <section>
                    <span className="label">Decision record</span>
                    <div className="flex flex-wrap items-center gap-2">
                      {decisions.length > 0 && (
                        <Select
                          className="!w-auto"
                          value=""
                          placeholder="Link an existing ADR…"
                          options={decisions.map((dd) => ({ value: dd.id, label: `ADR-${dd.number}: ${dd.title}` }))}
                          onValueChange={(v) => {
                            const dd = decisions.find((x) => x.id === v);
                            if (dd) router.push(`/p/${projectKey}/decisions#adr-${dd.number}`);
                          }}
                        />
                      )}
                      <button
                        className="btn px-2 py-1 text-xs"
                        disabled={busy}
                        onClick={() => void createAdrFromDoc()}
                      >
                        + Create ADR from this doc
                      </button>
                      <Link href={`/p/${projectKey}/decisions`} className="text-xs text-accent hover:underline">
                        View all decisions →
                      </Link>
                    </div>
                  </section>
                )}

                {d.anchors.length > 0 && (
                  <section>
                    <span className="label">Attached files</span>
                    <div className="flex flex-wrap gap-1.5">
                      {d.anchors.map((a) => (
                        <span key={a} className="chip gap-1 bg-panel-2 py-1 font-mono text-xs">
                          {a}
                        </span>
                      ))}
                    </div>
                  </section>
                )}

                <section>
                  <span className="label">Move</span>
                  <Select
                    value={d.parentId ?? ""}
                    options={[{ value: "", label: "Top level" }, ...tree.filter((t) => t.id !== d.id).map((t) => ({ value: t.id, label: t.title }))]}
                    onValueChange={async (v) => {
                      setBusy(true);
                      try {
                        const res = await moveDocAction(projectKey, d.id, { parent: v || null }, d.version);
                        if (!res.ok) return setError(res.error);
                        await refreshTree();
                        await load(d.id);
                        router.refresh();
                      } finally {
                        setBusy(false);
                      }
                    }}
                  />
                </section>

                <section>
                  <span className="label">Architecture</span>
                  <div className="flex flex-wrap gap-1.5">
                    {(detail?.nodes ?? []).map((n) => (
                      <span key={n.id} className="chip gap-1 bg-accent/10 py-1 text-accent">
                        ◇ {n.layer}:{n.name}
                        <button
                          className="text-accent/60 hover:text-accent"
                          aria-label={`Unlink ${n.name}`}
                          onClick={async () => {
                            await linkDocNodeAction(projectKey, d.id, n.id, true);
                            await load(d.id);
                            router.refresh();
                          }}
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                    {nodes.length > 0 ? (
                      <Select
                        className="!w-auto !border-dashed !bg-transparent !py-0.5 !text-xs !text-muted"
                        value=""
                        placeholder="+ link node"
                        options={nodes.filter((n) => !linkedIds.has(n.id)).map((n) => ({ value: n.id, label: `${n.layer}: ${n.name}` }))}
                        onValueChange={async (v) => {
                          if (!v) return;
                          await linkDocNodeAction(projectKey, d.id, v);
                          await load(d.id);
                          router.refresh();
                        }}
                      />
                    ) : (
                      <span className="text-xs text-muted">No nodes on the map yet.</span>
                    )}
                  </div>
                </section>
              </div>
            )}
          </div>
        )}
      </section>

      <Dialog.Root
        open={showBrowseRepo}
        onOpenChange={(o) => {
          setShowBrowseRepo(o);
          if (!o) setBrowseFiles(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[min(96vw,860px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-line bg-panel p-5 text-fg shadow-2xl">
            <Dialog.Title className="font-semibold">Browse repo</Dialog.Title>
            <Dialog.Description className="mt-1 text-xs text-muted">
              Pick a file from the connected repository&apos;s default branch to add it as an exact-path anchor.
            </Dialog.Description>
            {githubRepos.length > 1 && (
              <Select
                className="mt-3"
                value={browseRepoId}
                options={githubRepos.map((r) => ({ value: r.id, label: r.displayName }))}
                onValueChange={(v) => {
                  setBrowseRepoId(v);
                  setBrowseFiles(null);
                  setBrowseError(null);
                  void (async () => {
                    setBrowseBusy(true);
                    try {
                      const res = await browseRepoTreeAction(projectKey, v);
                      if (!res.ok) return setBrowseError(res.error);
                      setBrowseFiles((res.data as { files: { path: string }[] }).files.map((f) => f.path));
                    } finally {
                      setBrowseBusy(false);
                    }
                  })();
                }}
              />
            )}
            <input
              className="input mt-3 text-xs"
              placeholder="Filter files…"
              aria-label="Filter repo files"
              value={browseFilter}
              onChange={(e) => setBrowseFilter(e.target.value)}
              autoFocus
            />
            <div className="mt-2 min-h-0 flex-1 overflow-y-auto rounded-md border border-line p-1.5">
              {browseBusy ? (
                <p className="p-3 text-sm text-muted">Loading files from GitHub…</p>
              ) : browseError ? (
                <p className="p-3 text-sm text-danger">{browseError}</p>
              ) : !browseFiles || browseFiles.length === 0 ? (
                <p className="p-3 text-sm text-muted">No files found.</p>
              ) : (
                (() => {
                  const filter = browseFilter.trim().toLowerCase();
                  const tree = buildFileTree(browseFiles.slice(0, 2000));
                  const rendered = renderFileTreeNode(tree, 0, filter);
                  const flat = Array.isArray(rendered) ? rendered.filter(Boolean) : rendered ? [rendered] : [];
                  return flat.length === 0 ? <p className="p-3 text-sm text-muted">No files match &quot;{browseFilter}&quot;.</p> : flat;
                })()
              )}
            </div>
            <div className="mt-4 flex justify-end">
              <Dialog.Close className="btn">Done</Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={!!showTemplatePicker} onOpenChange={(o) => !o && setShowTemplatePicker(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(94vw,520px)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line bg-panel p-5 text-fg shadow-2xl">
            <Dialog.Title className="font-semibold">New doc</Dialog.Title>
            <Dialog.Description className="mt-1 text-xs text-muted">
              Start blank, or from a template — the body is pre-filled but still editable before you save.
            </Dialog.Description>
            <div className="mt-4 space-y-1.5">
              <button
                className="w-full rounded-md border border-dashed border-line p-3 text-left text-sm hover:bg-panel-2"
                disabled={busy}
                onClick={() => void createWithTemplate(null)}
              >
                <span className="font-medium">Blank</span>
                <p className="text-xs text-muted">Start with an empty doc.</p>
              </button>
              {DOC_TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  className="w-full rounded-md border border-line p-3 text-left text-sm hover:bg-panel-2"
                  disabled={busy}
                  onClick={() => void createWithTemplate(t.id)}
                >
                  <span className="font-medium">{t.name}</span>
                  <p className="text-xs text-muted">{t.description}</p>
                </button>
              ))}
            </div>
            <div className="mt-4 flex justify-end">
              <Dialog.Close className="btn">Cancel</Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {dialogs}
    </div>
  );
}
