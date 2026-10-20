import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import clsx from "clsx";
import { Dialog } from "radix-ui";
import { ApiError, type DocDetail, type DocPerson, type DocsIndex, type DocTemplateId } from "@wheelhouse/api-client";
import { DOC_TEMPLATES, extractActionItems } from "@wheelhouse/core/lib/doc-templates";
import { DescriptionEditor } from "../../components/description-editor";
import { Select, useDialogs } from "../../components/ui";
import { describeFailure } from "../../lib/form-state";
import { docQuery, useRepos } from "../../lib/queries";
import { refreshAll } from "../../lib/refresh";
import { useServices } from "../../lib/services";
import { buildFileTree, containsMatch, readTime, sectionOf, sortedChildren, type FileTreeNode } from "./file-tree";
import { AgentIcon, ArrowLeftIcon, ArrowRightIcon, BookIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, CloseIcon, EditIcon, FileIcon, FolderIcon, NodeIcon, SearchIcon, WarningIcon } from "../../components/icons";

type TreeDoc = DocsIndex["docs"][number];

/** A person (or agent) with a round initial, for the owner and contributors. */
function PersonRow({ person }: { person: DocPerson }) {
  return (
    <span className="flex items-center gap-2">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/15 text-xs font-semibold text-accent" aria-hidden>
        {person.kind === "agent" ? <AgentIcon /> : (person.name[0] ?? "?").toUpperCase()}
      </span>
      <span className="truncate">{person.name}</span>
    </span>
  );
}

/**
 * `/t/:key/docs`: a tree on the left (parent/child via `parentId`, same pattern as the map), a rich-text or Markdown editor on the
 * right. Version conflicts surface the way the issue dialog does: a banner when the doc changed under you, and a refused save that
 * never overwrites a concurrent edit.
 */
export function DocsExplorer({ teamKey, index, docId }: { teamKey: string; index: DocsIndex; docId?: string }) {
  const { nodes, decisions, members } = index;
  const tree = index.docs;
  const { api, queryClient } = useServices();
  const navigate = useNavigate();
  const selectedId = docId ?? null;
  const docPath = (id: string) => `/t/${teamKey}/docs/${encodeURIComponent(id)}`;
  const detailQuery = useQuery({ ...docQuery(api, teamKey, selectedId ?? ""), enabled: !!selectedId });
  const detail: DocDetail | undefined = selectedId ? detailQuery.data : undefined;
  // The doc being edited, not a flag: moving to another doc (the sheet, the browser's back button) leaves edit mode by itself.
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = selectedId !== null && editingId === selectedId;
  const [sheetOpen, setSheetOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [bodyBase, setBodyBase] = useState(0);
  const [anchors, setAnchors] = useState<string[]>([]);
  const [newAnchor, setNewAnchor] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copyLabel, setCopyLabel] = useState("Copy for agent");
  // WH-65: which template (if any) the doc was created from in this session, so the "Link or create ADR" affordance shows for decision records.
  const [docTemplateId, setDocTemplateId] = useState<DocTemplateId | null>(null);
  const [showTemplatePicker, setShowTemplatePicker] = useState<{ parentId: string | null } | null>(null);
  const [actionItemBusy, setActionItemBusy] = useState<number | null>(null);
  const [treeFilter, setTreeFilter] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [showBrowseRepo, setShowBrowseRepo] = useState(false);
  const [browseRepoId, setBrowseRepoId] = useState<string>("");
  const [browseFiles, setBrowseFiles] = useState<string[] | null>(null);
  const [browseFilter, setBrowseFilter] = useState("");
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [browseBusy, setBrowseBusy] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const { confirm, dialogs } = useDialogs();

  const repos = useRepos(teamKey);
  const githubRepos = useMemo(() => (repos.data ?? []).filter((r) => r.browsable), [repos.data]);
  useEffect(() => {
    if (githubRepos.length) setBrowseRepoId((id) => id || githubRepos[0].id);
  }, [githubRepos]);

  const d = detail?.doc;
  const refresh = () => refreshAll(queryClient);

  const selectDoc = (id: string) => {
    setDocTemplateId(null); // the template is only known right after creating a doc in this session
    setError(null);
    setSheetOpen(false);
    void navigate(docPath(id));
  };

  const startEditing = (doc: NonNullable<typeof d>) => {
    setTitle(doc.title);
    setBody(doc.body);
    setBodyBase(doc.version);
    setAnchors(doc.anchors);
    setSuggestions([]);
    setEditingId(doc.id);
  };

  // An empty doc goes straight into edit mode — there's nothing to preview, so showing the editor directly
  // (rather than an "Add content…" placeholder) is always what's wanted next.
  useEffect(() => {
    if (!detail || editing) return;
    if (detail.doc.body) return;
    startEditing(detail.doc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail]);

  const byParent = useMemo(() => {
    const m = new Map<string | null, TreeDoc[]>();
    for (const t of tree) {
      const arr = m.get(t.parentId) ?? [];
      arr.push(t);
      m.set(t.parentId, arr);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.position - b.position);
    return m;
  }, [tree]);

  const createWithTemplate = async (templateId: DocTemplateId | null) => {
    const parentId = showTemplatePicker?.parentId ?? null;
    const t = templateId ? DOC_TEMPLATES.find((x) => x.id === templateId) : undefined;
    setBusy(true);
    try {
      const created = await api.docs.create(teamKey, { title: t ? t.name : "Untitled doc", parent: parentId, template: templateId ?? undefined });
      void navigate(docPath(created.id));
      setShowTemplatePicker(null);
      setSheetOpen(false);
      setDocTemplateId(templateId);
      setError(null);
      startEditing(created); // still just an editable draft — nothing further is "saved" until Save is clicked
      await refresh();
    } catch (e) {
      setError(describeFailure(e));
    } finally {
      setBusy(false);
    }
  };

  const actionItems = useMemo(() => (d?.body ? extractActionItems(d.body) : []), [d?.body]);
  const linkedIds = new Set((detail?.nodes ?? []).map((n) => n.id));

  /**
   * One-click "Create issue" for an unchecked action item (WH-65). The issue goes in the team's default column with the item's
   * text as title — one-shot, no bidirectional sync — then the box is checked in the doc body so it isn't offered twice.
   */
  const createIssueFromActionItem = async (item: { text: string; line: number }) => {
    if (!d) return;
    setActionItemBusy(item.line);
    try {
      await api.issues.create(teamKey, { title: item.text });
      const lines = d.body.split("\n");
      lines[item.line] = lines[item.line].replace(/\[ \]/, "[x]");
      await api.docs.update(teamKey, d.id, { body: lines.join("\n"), version: d.version });
      await refresh();
    } catch (e) {
      setError(describeFailure(e));
    } finally {
      setActionItemBusy(null);
    }
  };

  /** "Create ADR from this doc" (WH-65): seeds a new ADR from a decision-record doc's title and sections, through the decisions endpoint. */
  const createAdrFromDoc = async () => {
    if (!d) return;
    setBusy(true);
    try {
      await api.map.upsertDecision(teamKey, {
        title: d.title,
        status: "proposed",
        context: sectionOf(d.body, "Context"),
        decision: sectionOf(d.body, "Decision"),
        consequences: sectionOf(d.body, "Consequences"),
      });
      void navigate(`/t/${teamKey}/decisions`);
    } catch (e) {
      setError(describeFailure(e));
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
        setEditingId(null);
        return true;
      }
      try {
        await api.docs.update(teamKey, d.id, { ...patch, version: bodyBase });
      } catch (e) {
        setError(e instanceof ApiError ? e.message || "Failed" : describeFailure(e));
        await refresh();
        return false;
      }
      setError(null);
      await refresh();
      return true;
    } finally {
      setBusy(false);
    }
  };

  /** Labels save as soon as they change (no Save button), against the version that was read; a refusal is shown and the doc reloaded. */
  const saveLabels = async (labels: string[]) => {
    if (!d) return false;
    setBusy(true);
    try {
      const saved = await api.docs.update(teamKey, d.id, { labels, version: d.version });
      // Mid-edit, a label change is not someone else's edit: carry the editor's base version forward so Save is not refused.
      if (editing && bodyBase === d.version) setBodyBase(saved.version);
      setError(null);
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message || "Failed" : describeFailure(e));
      return false;
    } finally {
      await refresh();
      setBusy(false);
    }
  };

  const confirmAccurate = async () => {
    if (!d) return;
    setBusy(true);
    try {
      await api.docs.markFresh(teamKey, d.id);
      await refresh();
    } catch (e) {
      setError(describeFailure(e));
    } finally {
      setBusy(false);
    }
  };

  const loadTree = async (repoId: string) => {
    setBrowseBusy(true);
    try {
      setBrowseFiles((await api.repos.tree(teamKey, repoId)).files);
    } catch (e) {
      setBrowseError(describeFailure(e));
    } finally {
      setBrowseBusy(false);
    }
  };

  const openBrowseRepo = async () => {
    setShowBrowseRepo(true);
    setBrowseError(null);
    setBrowseFilter("");
    if (browseRepoId) await loadTree(browseRepoId);
  };

  const addAnchorFromBrowse = (path: string) => {
    if (!anchors.includes(path)) setAnchors([...anchors, path]);
  };

  const toggleDir = (path: string) =>
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  /** Recursively render a directory tree node; folders matching the filter (by any descendant file) auto-expand. */
  const renderFileTreeNode = (node: FileTreeNode, depth: number, filter: string): React.ReactNode =>
    sortedChildren(node).map((child) => {
      if (child.isFile) {
        if (filter && !child.path.toLowerCase().includes(filter)) return null;
        return (
          <button
            key={child.path}
            type="button"
            className={clsx("flex w-full items-center gap-1.5 truncate rounded px-2 py-1 text-left font-mono text-xs hover:bg-panel-2", anchors.includes(child.path) ? "text-accent" : "text-fg")}
            style={{ paddingLeft: `${depth * 1.1 + 0.5}rem` }}
            title={child.path}
            onClick={() => addAnchorFromBrowse(child.path)}
          >
            {anchors.includes(child.path) ? <CheckIcon /> : <FileIcon />}
            <span className="truncate">{child.name}</span>
          </button>
        );
      }
      // A folder is shown (and auto-expanded while filtering) only if some descendant file matches.
      if (filter && !containsMatch(child, filter)) return null;
      const expanded = filter ? true : expandedDirs.has(child.path);
      return (
        <div key={child.path}>
          <button
            type="button"
            className="flex w-full items-center gap-1.5 truncate rounded px-2 py-1 text-left font-mono text-xs text-muted hover:bg-panel-2 hover:text-fg"
            style={{ paddingLeft: `${depth * 1.1 + 0.5}rem` }}
            onClick={() => toggleDir(child.path)}
          >
            {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
            <FolderIcon />
            <span className="truncate">{child.name}</span>
          </button>
          {expanded && renderFileTreeNode(child, depth + 1, filter)}
        </div>
      );
    });

  const loadSuggestions = async () => {
    if (!d) return;
    try {
      setSuggestions(await api.docs.anchorSuggestions(teamKey, d.id));
    } catch (e) {
      setError(describeFailure(e));
    }
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
  // Doc-tree search (WH-82): with a search term we show a flat list of every doc whose title matches (simpler than preserving
  // nesting, and still surfaces nested matches); with none, the nested tree renders.
  const filteredFlat = filterTerm ? tree.filter((t) => t.title.toLowerCase().includes(filterTerm)).sort((a, b) => a.title.localeCompare(b.title)) : null;

  /** One doc in the list. `home`: the roomier rows of the docs home screen, with the date it was last changed; otherwise the compact rows of the sheet. */
  const docRow = (k: TreeDoc, depth: number, home: boolean) => (
    <li key={k.id} className="group/doc">
      <div className="flex items-center gap-0.5">
        <button
          onClick={() => selectDoc(k.id)}
          aria-current={selectedId === k.id ? "true" : undefined}
          className={clsx(
            "flex min-w-0 flex-1 items-center gap-1.5 truncate rounded-md px-2 text-left transition-colors",
            home ? "py-2.5 text-[15px] text-fg hover:bg-panel-2/70" : "py-1.5 text-sm",
            !home && (selectedId === k.id ? "bg-accent/10 font-medium text-accent" : "text-muted hover:bg-panel-2/70 hover:text-fg"),
          )}
          title={k.title}
        >
          {k.stale && <span className="text-warn" title="Possibly out of date"><WarningIcon /></span>}
          <span className="truncate">{k.title}</span>
        </button>
        {home && <span className="hidden shrink-0 px-2 text-xs text-muted sm:inline">Updated {new Date(k.updatedAt).toLocaleDateString()}</span>}
      </div>
      {!filterTerm && renderNode(k.id, depth + 1, home)}
    </li>
  );

  const renderNode = (parentId: string | null, depth: number, home: boolean): React.ReactNode => {
    const kids = byParent.get(parentId) ?? [];
    if (!kids.length) return null;
    return <ul className={depth === 0 ? "space-y-0.5" : "ml-3 space-y-0.5 border-l border-line pl-2"}>{kids.map((k) => docRow(k, depth, home))}</ul>;
  };

  /** Search box plus the nested tree (or the flat list of matches while searching): the body of both the home screen and the sheet. */
  const docList = (home: boolean) => (
    <>
      {tree.length > 0 && (
        <div className="relative mb-3">
          <input
            type="search"
            className="input !rounded-full !border-transparent !bg-panel-2/70 !py-1.5 !pr-8 text-sm focus:!border-accent"
            placeholder="Search docs…"
            aria-label="Filter docs by title"
            value={treeFilter}
            onChange={(e) => setTreeFilter(e.target.value)}
          />
          <SearchIcon className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-base text-muted" />
        </div>
      )}
      {tree.length === 0 ? (
        <p className="px-2 py-4 text-sm text-muted">No docs yet. Create one to get started.</p>
      ) : filteredFlat ? (
        filteredFlat.length === 0 ? (
          <p className="px-2 py-4 text-sm text-muted">No docs match &quot;{treeFilter}&quot;.</p>
        ) : (
          <ul className="space-y-0.5">{filteredFlat.map((k) => docRow(k, 0, home))}</ul>
        )
      ) : (
        renderNode(null, 0, home)
      )}
    </>
  );

  /** Parents of the open doc, outermost first, for the breadcrumb. */
  const ancestors = (() => {
    const chain: TreeDoc[] = [];
    let cur = d ? tree.find((t) => t.id === d.parentId) : undefined;
    while (cur && chain.length < 12) {
      chain.unshift(cur);
      cur = tree.find((t) => t.id === cur!.parentId);
    }
    return chain;
  })();

  const authorName = (kind: "human" | "agent", id: string | null) => (kind === "agent" ? "Agent" : (members.find((m) => m.id === id)?.name ?? "Someone"));
  const authorInitial = (kind: "human" | "agent", id: string | null) => (kind === "agent" ? <AgentIcon /> : (authorName(kind, id)[0] ?? "?").toUpperCase());
  const loadError = selectedId && detailQuery.isError ? (detailQuery.error instanceof ApiError ? detailQuery.error.message : "Could not load this doc.") : null;

  return (
    <div className="confluence-docs flex h-full flex-col overflow-hidden bg-bg">
      {selectedId === null ? (
        <section className="min-h-0 flex-1 overflow-y-auto">
          <div className="w-full px-4 py-8 sm:px-8 lg:py-12">
            <div className="mb-6 flex items-center justify-between gap-3">
              <h1 className="text-3xl font-bold tracking-tight">Docs</h1>
              <button className="btn btn-primary" disabled={busy} onClick={() => setShowTemplatePicker({ parentId: null })}>
                + Create
              </button>
            </div>
            {error && <p role="alert" className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
            {docList(true)}
          </div>
        </section>
      ) : (
        <>
          <nav aria-label="Doc navigation" className="flex items-center gap-2 border-b border-line/70 px-4 py-2 text-xs sm:px-8 lg:px-12">
            <Link to={`/t/${teamKey}/docs`} className="shrink-0 text-muted hover:text-fg">
              <ArrowLeftIcon /> Docs
            </Link>
            {ancestors.map((a) => (
              <span key={a.id} className="flex min-w-0 items-center gap-2 text-muted">
                <span aria-hidden>/</span>
                <Link to={docPath(a.id)} className="truncate hover:text-fg">
                  {a.title}
                </Link>
              </span>
            ))}
            <button type="button" aria-label="Search docs" className="btn btn-ghost ml-auto flex shrink-0 items-center gap-1.5 px-2 py-1 text-xs" onClick={() => setSheetOpen(true)}>
              <SearchIcon className="text-sm" />
              Search
            </button>
          </nav>

          <section className="min-h-0 flex-1 overflow-y-auto">
            {!d ? (
              <p className="px-4 py-8 text-sm text-muted sm:px-8 lg:px-12">{error ?? loadError ?? (detailQuery.isPending ? "Loading…" : "Select a doc, or create one.")}</p>
            ) : (
              <div className="grid w-full gap-8 px-4 py-8 sm:px-8 md:grid-cols-[minmax(0,1fr)_16rem] lg:px-12 lg:py-10">
                <div className="min-w-0 space-y-5">
            {error && <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

            {d.stale && (
              <p role="status" className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
                <WarningIcon /> Possibly out of date{d.staleReason ? `: ${d.staleReason}` : ""}. Edit the content to refresh it, or confirm it&apos;s still accurate.
                <button className="ml-2 underline" disabled={busy} onClick={confirmAccurate}>
                  Confirm accurate
                </button>
              </p>
            )}

            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                {editing ? (
                  <input className="input !border-none !bg-transparent !px-0 !text-3xl !font-bold" aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
                ) : (
                  <h1 className="truncate text-3xl font-bold tracking-tight">{d.title}</h1>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                {!editing ? (
                  <button className="btn btn-primary" onClick={() => startEditing(d)}>
                    <EditIcon /> Edit
                  </button>
                ) : null}
                <button
                  className="btn btn-danger"
                  disabled={busy}
                  onClick={async () => {
                    if (!(await confirm({ title: `Delete "${d.title}"?`, description: "This also removes any nested docs underneath it.", confirmLabel: "Delete", danger: true }))) return;
                    setBusy(true);
                    try {
                      await api.docs.delete(teamKey, d.id);
                      setEditingId(null);
                      void navigate(`/t/${teamKey}/docs`);
                      await refresh();
                    } catch (e) {
                      setError(describeFailure(e));
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
              <span><BookIcon /> {readTime(d.body)} min read</span>
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
                          <SearchIcon className="text-sm" />
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
                        <button className="text-muted hover:text-fg" aria-label={`Remove anchor ${a}`} onClick={() => setAnchors(anchors.filter((x) => x !== a))}>
                          <CloseIcon />
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
                  <button
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={async () => {
                      if (await save()) setEditingId(null);
                    }}
                  >
                    Save
                  </button>
                  <button className="btn" onClick={() => setEditingId(null)}>
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
                          <button className="btn btn-ghost shrink-0 px-2 py-1 text-xs" disabled={actionItemBusy === item.line} onClick={() => void createIssueFromActionItem(item)}>
                            {actionItemBusy === item.line ? "Creating…" : "Create issue"}
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
                            if (dd) void navigate(`/t/${teamKey}/decisions#adr-${dd.number}`);
                          }}
                        />
                      )}
                      <button className="btn px-2 py-1 text-xs" disabled={busy} onClick={() => void createAdrFromDoc()}>
                        + Create ADR from this doc
                      </button>
                      <Link to={`/t/${teamKey}/decisions`} className="text-xs text-accent hover:underline">
                        View all decisions <ArrowRightIcon />
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
                        await api.docs.move(teamKey, d.id, { parent: v || null, version: d.version });
                        setError(null);
                      } catch (e) {
                        setError(describeFailure(e));
                      } finally {
                        await refresh();
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
                        <NodeIcon /> {n.layer}:{n.name}
                        <button
                          className="text-accent/60 hover:text-accent"
                          aria-label={`Unlink ${n.name}`}
                          onClick={async () => {
                            try {
                              await api.docs.unlinkNode(teamKey, d.id, n.id);
                            } catch (e) {
                              setError(describeFailure(e));
                            }
                            await refresh();
                          }}
                        >
                          <CloseIcon />
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
                          try {
                            await api.docs.linkNode(teamKey, d.id, v);
                          } catch (e) {
                            setError(describeFailure(e));
                          }
                          await refresh();
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
                                  <aside aria-label="About this doc" className="space-y-5 self-start text-sm md:sticky md:top-6">
                    <section>
                      <span className="label">Owner</span>
                      <PersonRow person={detail!.owner} />
                    </section>
                    <section>
                      <span className="label">Contributors</span>
                      {detail!.contributors.length ? (
                        <ul className="space-y-1.5">
                          {detail!.contributors.map((c) => (
                            <li key={`${c.kind}:${c.id ?? c.name}`}>
                              <PersonRow person={c} />
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-xs text-muted">No one else yet.</p>
                      )}
                    </section>
                    <section>
                      <span className="label">Labels</span>
                      <div className="flex flex-wrap gap-1.5">
                        {d.labels.map((l) => (
                          <span key={l} className="chip gap-1 bg-panel-2 py-1 text-xs text-fg">
                            {l}
                            <button className="text-muted hover:text-fg" aria-label={`Remove label ${l}`} disabled={busy} onClick={() => void saveLabels(d.labels.filter((x) => x !== l))}>
                              <CloseIcon />
                            </button>
                          </span>
                        ))}
                        <input
                          className="input !w-28 !py-0.5 text-xs"
                          aria-label="Add a label"
                          placeholder="+ label"
                          value={newLabel}
                          disabled={busy}
                          onChange={(e) => setNewLabel(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key !== "Enter" || !newLabel.trim()) return;
                            e.preventDefault();
                            void saveLabels([...d.labels, newLabel]).then((ok) => ok && setNewLabel(""));
                          }}
                        />
                      </div>
                    </section>
                  </aside>
              </div>
            )}
          </section>
        </>
      )}

      <Dialog.Root open={sheetOpen} onOpenChange={setSheetOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed inset-y-0 left-0 z-50 flex w-[min(88vw,22rem)] flex-col border-r border-line bg-panel p-4 text-fg shadow-2xl"
          >
            <div className="mb-3 flex items-center justify-between">
              <Dialog.Title className="text-xs font-semibold uppercase tracking-wide text-muted">Docs</Dialog.Title>
              <div className="flex items-center gap-1">
                <button className="rounded px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10" disabled={busy} onClick={() => setShowTemplatePicker({ parentId: null })}>
                  + Create
                </button>
                <Dialog.Close className="rounded px-2 py-1 text-muted hover:bg-panel-2 hover:text-fg" aria-label="Close">
                  <CloseIcon />
                </Dialog.Close>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">{docList(false)}</div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

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
            <Dialog.Description className="mt-1 text-xs text-muted">Pick a file from the connected repository&apos;s default branch to add it as an exact-path anchor.</Dialog.Description>
            {githubRepos.length > 1 && (
              <Select
                className="mt-3"
                value={browseRepoId}
                options={githubRepos.map((r) => ({ value: r.id, label: r.displayName }))}
                onValueChange={(v) => {
                  setBrowseRepoId(v);
                  setBrowseFiles(null);
                  setBrowseError(null);
                  void loadTree(v);
                }}
              />
            )}
            <input className="input mt-3 text-xs" placeholder="Filter files…" aria-label="Filter repo files" value={browseFilter} onChange={(e) => setBrowseFilter(e.target.value)} autoFocus />
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
                  const rendered = renderFileTreeNode(buildFileTree(browseFiles.slice(0, 2000)), 0, filter);
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
            <Dialog.Description className="mt-1 text-xs text-muted">Start blank, or from a template — the body is pre-filled but still editable before you save.</Dialog.Description>
            <div className="mt-4 space-y-1.5">
              <button className="w-full rounded-md border border-dashed border-line p-3 text-left text-sm hover:bg-panel-2" disabled={busy} onClick={() => void createWithTemplate(null)}>
                <span className="font-medium">Blank</span>
                <p className="text-xs text-muted">Start with an empty doc.</p>
              </button>
              {DOC_TEMPLATES.map((t) => (
                <button key={t.id} className="w-full rounded-md border border-line p-3 text-left text-sm hover:bg-panel-2" disabled={busy} onClick={() => void createWithTemplate(t.id)}>
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
