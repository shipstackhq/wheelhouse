import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import clsx from "clsx";
import type { CycleOption, TeamProjectOption } from "@wheelhouse/api-client";
import { describeFailure } from "../../lib/form-state";
import { useServices } from "../../lib/services";
import { neighbours, parseIssueParam } from "../../lib/issue-nav";
import { fieldPatch, retagIssue, startingFields, type IssueGroup } from "../../lib/issue-view";
import type { Relations } from "../../lib/sub-issues";
import { SubIssueProgress } from "../../components/sub-issue-progress";
import { dragOver, drop, findCol, itemsOf, type Items } from "./board-state";
import { ColumnControls, EMPTY_VIEW, applyView, describeSort, isFiltered, loadView, matches, saveView, type View } from "./column-controls";
import { PRIORITY_STYLE, type Col, type Member, type NodeLite, type Issue } from "./shared";
import { IssueDialog } from "./issue-dialog";
import { AgentIcon, CloseIcon, CommentIcon, CyclesIcon, NodeIcon, ProjectsIcon } from "../../components/icons";
import { cycleTitle } from "../cycles/cycle-bits";
import { wsKey } from "../../lib/workspace";

/**
 * The kanban board. What is on screen is a local copy of the server's issues, so a drag can move cards at once. The server's
 * copy replaces it whenever nothing is being dragged (that is how a teammate's or an agent's change shows up), and again, with the
 * real positions, when a drop has been saved.
 */
const NO_CYCLES: CycleOption[] = [];
const NO_PROJECTS: TeamProjectOption[] = [];
const NO_ISSUES: Issue[] = [];

export function Board(props: {
  teamKey: string;
  /** The columns, each with the issues in it: the view's groups (by status, priority, person, project, cycle, or all in one). */
  groups: IssueGroup[];
  /** The team's statuses, for the issue dialog's Status field (the columns may be something else). */
  statuses: Col[];
  /** True when a column's order is the manual board order, which only a board grouped by status and not sorted has. */
  manualOrder: boolean;
  /** Whose sub-issue a card is and how its own sub-issues are getting on. */
  relations: Relations;
  nodes: NodeLite[];
  members: Member[];
  cycles?: CycleOption[];
  projects?: TeamProjectOption[];
}) {
  const { teamKey, groups, statuses, nodes, members, relations } = props;
  const columns = useMemo(() => groups.map((g) => ({ id: g.id, name: g.label })), [groups]);
  const cycles = props.cycles ?? NO_CYCLES;
  const projects = props.projects ?? NO_PROJECTS;
  const { api, queryClient } = useServices();
  const [search, setSearch] = useSearchParams();
  const [items, setItems] = useState<Items>(() => itemsOf(groups));
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dragging = useRef(false);
  const dragFrom = useRef<string | null>(null);
  const [views, setViews] = useState<Record<string, View>>({});
  const [notice, setNotice] = useState<string | null>(null);
  // A column's own filter and sort are kept under its status id, as they always were; other columns under their group id.
  const viewKey = (colId: string) => `wh:view:${teamKey}:${colId.replace(/^status:/, "")}`;
  const whatOf = (colId: string) => groups.find((g) => g.id === colId)?.what;
  const viewOf = (colId: string) => views[colId] ?? EMPTY_VIEW;
  // ?t= is the source of truth for the open issue; a value that isn't an issue ref is ignored.
  const openRef = parseIssueParam(search.get("t"));

  const refreshBoard = useCallback(() => queryClient.invalidateQueries({ queryKey: wsKey(api, "board", teamKey) }), [api, queryClient, teamKey]);

  // Server state wins whenever we aren't mid-drag (live updates from agents/teammates).
  useEffect(() => {
    if (!dragging.current) setItems(itemsOf(groups));
  }, [groups]);

  // Restore each column's filter/sort when the team or its columns change.
  // Keyed on the column ids, not the array: a refresh hands over a new array, and reloading here would give each Column a fresh
  // view object and un-pin issues it just added.
  const statusIds = columns.map((c) => c.id).join(",");
  useEffect(() => {
    setViews(Object.fromEntries(columns.map((c) => [c.id, loadView(viewKey(c.id))])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamKey, statusIds]);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(id);
  }, [notice]);

  const changeView = useCallback((colId: string, v: View) => {
    setViews((prev) => ({ ...prev, [colId]: v }));
    saveView(viewKey(colId), v);
  }, [teamKey]);

  const labels = useMemo(() => [...new Set(groups.flatMap((g) => g.issues.flatMap((t) => t.labels)))].sort(), [groups]);
  const startsById = useMemo(() => new Map(groups.map((g) => [g.id, startingFields(g.what)])), [groups]);

  const byId = useMemo(() => {
    const m = new Map<string, Issue>();
    for (const list of Object.values(items)) for (const t of list) m.set(t.id, t);
    return m;
  }, [items]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // Pointer position decides first, so an empty column is hit when the cursor is over it; closestCorners
  // alone favours cards in neighbouring columns and never selects an empty one.
  const collision: CollisionDetection = (args) => {
    const hits = pointerWithin(args);
    return hits.length ? hits : closestCorners(args);
  };

  const onDragStart = (e: DragStartEvent) => {
    dragging.current = true;
    setActiveId(String(e.active.id));
    dragFrom.current = findCol(items, String(e.active.id)) ?? null;
  };

  const onDragOver = (e: DragOverEvent) => {
    if (!e.over) return;
    const { active, over } = e;
    setItems((prev) => dragOver(prev, String(active.id), String(over.id), (t, colId) => {
      const what = whatOf(colId);
      return what ? retagIssue(what, t) : t;
    }));
  };

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    setActiveId(null);
    const result = drop(items, String(active.id), over ? String(over.id) : null, dragFrom.current, (col) => !!viewOf(col).sort || !props.manualOrder);
    setItems(result.items);
    if (!result.move) {
      dragging.current = false;
      return;
    }
    const { colId, index, crossed } = result.move;
    const t = byId.get(String(active.id))!;
    const what = whatOf(colId);
    const target = viewOf(colId);
    if (crossed && isFiltered(target) && !matches(t, target)) {
      setNotice(`${t.ref} moved to ${columns.find((c) => c.id === colId)?.name}, but the column filter hides it.`);
    }
    void (async () => {
      try {
        // A status column is a move (which also says where in the column); any other column is a change to the one field it groups by.
        if (what?.kind === "status") await api.issues.move(t.ref, { status: what.status.id, index });
        else {
          const patch = what && crossed ? fieldPatch(what) : null;
          if (patch) await api.issues.update(t.ref, { ...patch, version: t.version });
        }
      } catch (err) {
        setError(describeFailure(err));
      } finally {
        dragging.current = false;
        await refreshBoard(); // the server's positions replace the local ones (and undo a move the server refused)
      }
    })();
  };

  const openIssue = useCallback((ref: string | null) => {
    const sp = new URLSearchParams(search);
    if (ref) sp.set("t", ref);
    else sp.delete("t");
    setSearch(sp, { replace: true, preventScrollReset: true });
  }, [search, setSearch]);

  const active = activeId ? byId.get(activeId) : null;

  // Previous/next in the dialog walk the open issue's column in the order the board shows it (filter and sort applied);
  // if a filter hides the open issue, fall back to the whole column.
  const openCol = openRef ? Object.keys(items).find((c) => items[c].some((t) => t.ref === openRef)) : undefined;
  const nav = (() => {
    if (!openRef || !openCol) return neighbours([], openRef ?? "");
    const shown = applyView(items[openCol], viewOf(openCol)).map((t) => t.ref);
    return neighbours(shown.includes(openRef) ? shown : items[openCol].map((t) => t.ref), openRef);
  })();

  return (
    <div className="flex h-full">
      <div className="min-w-0 flex-1 overflow-x-auto">
        {error && (
          <div role="alert" className="mx-5 mt-3 flex items-center justify-between rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
            <button onClick={() => setError(null)} aria-label="Dismiss"><CloseIcon /></button>
          </div>
        )}
        {notice && (
          <div role="status" className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border border-line bg-panel px-3 py-2 text-sm shadow-xl">
            {notice}
          </div>
        )}
        <DndContext id="board-dnd" sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd}>
          <div className="flex h-full gap-3 px-4 pb-4">
            {columns.map((c) => (
              <Column
                key={c.id}
                col={c}
                issues={items[c.id] ?? NO_ISSUES}
                view={viewOf(c.id)}
                onViewChange={changeView}
                members={members}
                labels={labels}
                cycles={cycles}
                projects={projects}
                nodes={nodes}
                onOpen={openIssue}
                selected={openRef}
                teamKey={teamKey}
                relations={relations}
                starts={startsById.get(c.id)!}
                onCreated={refreshBoard}
              />
            ))}
          </div>
          <DragOverlay>{active ? <Card t={active} nodes={nodes} cycles={cycles} projects={projects} relations={relations} overlay /> : null}</DragOverlay>
        </DndContext>
      </div>
      {openRef && (
        <IssueDialog
          key={openRef}
          issueRef={openRef}
          teamKey={teamKey}
          columns={statuses}
          nodes={nodes}
          members={members}
          cycles={cycles}
          projects={projects}
          nav={nav}
          onNavigate={openIssue}
          onClose={() => openIssue(null)}
        />
      )}
    </div>
  );
}

const Column = memo(ColumnBody);

function ColumnBody(props: {
  col: Col;
  issues: Issue[];
  view: View;
  onViewChange: (colId: string, v: View) => void;
  members: Member[];
  labels: string[];
  cycles: CycleOption[];
  projects: TeamProjectOption[];
  nodes: NodeLite[];
  selected: string | null;
  teamKey: string;
  relations: Relations;
  /** What an issue added in this column starts with: its status, or whatever the column groups by. */
  starts: ReturnType<typeof startingFields>;
  onOpen: (ref: string) => void;
  onCreated: () => void;
}) {
  const { api } = useServices();
  const { col, view } = props;
  const { setNodeRef, isOver } = useDroppable({ id: col.id });
  // Issues that arrive after "+ Add issue" stay visible despite the filter, so the add doesn't look like it failed.
  const [pinFrom, setPinFrom] = useState<Set<string> | null>(null);
  const issues = useMemo(
    () => applyView(props.issues, view, pinFrom ? (t) => !pinFrom.has(t.id) : undefined),
    [props.issues, view, pinFrom],
  );
  useEffect(() => setPinFrom(null), [view]);
  const ids = useMemo(() => issues.map((t) => t.id), [issues]);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const submitting = useRef(false);
  const cancelled = useRef(false);

  const submit = (keepOpen: boolean) => {
    if (cancelled.current) return;
    const value = title.trim();
    if (!value) return keepOpen ? undefined : setAdding(false);
    if (submitting.current) return;
    submitting.current = true;
    if (isFiltered(view)) setPinFrom((prev) => prev ?? new Set(props.issues.map((t) => t.id)));
    setTitle("");
    if (!keepOpen) setAdding(false);
    void (async () => {
      try {
        await api.issues.create(props.teamKey, { title: value, ...props.starts });
        props.onCreated();
      } catch {
        props.onCreated(); // whatever happened, show the board as the server has it
      } finally {
        submitting.current = false;
      }
    })();
  };

  return (
    <div className={clsx("flex w-72 shrink-0 flex-col rounded-lg bg-panel-2/60", isOver && "ring-1 ring-accent/40")} data-column={col.id}>
      <div className="group/head flex items-center justify-between gap-2 px-3 py-2.5">
        <span className="text-sm font-medium">{col.name}</span>
        <div className="flex min-w-0 items-center gap-2">
          <ColumnControls view={view} onChange={(v) => props.onViewChange(col.id, v)} members={props.members} labels={props.labels} cycles={props.cycles} />
          <span className="shrink-0 text-xs text-muted">
            {issues.length === props.issues.length ? issues.length : `${issues.length} of ${props.issues.length}`}
          </span>
        </div>
      </div>
      {view.sort && <div className="px-3 pb-1 text-[11px] text-muted">sorted by {describeSort(view)}; drag order is off</div>}
      <div ref={setNodeRef} className="flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {issues.map((t) => (
            <SortableCard key={t.id} t={t} nodes={props.nodes} cycles={props.cycles} projects={props.projects} relations={props.relations} selected={props.selected === t.ref} onOpen={props.onOpen} />
          ))}
        </SortableContext>
        {adding ? (
          <textarea
            autoFocus
            className="input resize-none"
            rows={2}
            aria-label={`New issue in ${col.name}`}
            placeholder="Issue title, Enter to add"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => submit(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit(true);
              }
              if (e.key === "Escape") {
                cancelled.current = true;
                setTitle("");
                setAdding(false);
              }
            }}
          />
        ) : (
          <button
            className="rounded-md px-2 py-1.5 text-left text-sm text-muted hover:bg-panel-2 hover:text-fg"
            onClick={() => {
              cancelled.current = false;
              setAdding(true);
            }}
          >
            + Add issue
          </button>
        )}
      </div>
    </div>
  );
}

const SortableCard = memo(SortableCardBody);

function SortableCardBody({ t, nodes, cycles, projects, relations, selected, onOpen }: { t: Issue; nodes: NodeLite[]; cycles: CycleOption[]; projects: TeamProjectOption[]; relations: Relations; selected: boolean; onOpen: (ref: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: t.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      onClick={() => onOpen(t.ref)}
      className={clsx(isDragging && "opacity-30")}
      data-issue={t.ref}
    >
      <Card t={t} nodes={nodes} cycles={cycles} projects={projects} relations={relations} selected={selected} />
    </div>
  );
}

const Card = memo(CardBody);

function CardBody({ t, nodes, cycles, projects, relations, selected, overlay }: { t: Issue; nodes: NodeLite[]; cycles: CycleOption[]; projects: TeamProjectOption[]; relations: Relations; selected?: boolean; overlay?: boolean }) {
  const parentRef = relations.parentRef(t);
  const progress = relations.progress(t);
  const linked = t.nodeIds.map((id) => nodes.find((n) => n.id === id)).filter(Boolean) as NodeLite[];
  const project = t.projectId ? projects.find((x) => x.id === t.projectId) : undefined;
  const cycle = t.cycle == null ? null : (cycles.find((c) => c.number === t.cycle) ?? { number: t.cycle, name: "", startsAt: "", endsAt: "", state: "current" as const });
  return (
    <div
      className={clsx(
        "cursor-grab rounded-md border bg-card p-2.5 text-sm shadow-sm active:cursor-grabbing",
        selected ? "border-accent" : "border-line hover:border-muted/50",
        overlay && "rotate-2 shadow-xl",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-[11px] text-muted">{t.ref}</span>
        <div className="flex gap-1">
          {t.createdByKind === "agent" && <span className="chip bg-agent/15 text-agent" title="Created by an agent"><AgentIcon /></span>}
          {t.delegateAgentId && <span className="chip bg-agent/10 text-agent" title="Delegated to an agent"><AgentIcon /></span>}
          {t.priority !== "none" && <span className={clsx("chip", PRIORITY_STYLE[t.priority])}>{t.priority}</span>}
        </div>
      </div>
      <div className="mt-1 leading-snug">{t.title}</div>
      {(t.labels.length > 0 || linked.length > 0 || t.commentCount > 0 || t.agentClaimable || cycle || project || parentRef || progress) && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {parentRef && (
            <span className="chip bg-bg text-muted" title={`Sub-issue of ${parentRef}`} data-parent-chip>
              ↳ {parentRef}
            </span>
          )}
          {progress && <SubIssueProgress progress={progress} />}
          {project && (
            <span className="chip max-w-[10rem] bg-accent/10 text-accent/90" title={`Project: ${project.name}`} data-project-chip>
              <ProjectsIcon /> <span className="truncate">{project.name}</span>
            </span>
          )}
          {cycle && (
            <span className="chip bg-ok/10 text-ok" title={cycleTitle(cycle)} data-cycle-chip>
              <CyclesIcon /> {cycle.number}
            </span>
          )}
          {t.labels.map((l) => (
            <span key={l} className="chip bg-bg text-muted">{l}</span>
          ))}
          {linked.map((n) => (
            <span key={n.id} className="chip bg-accent/10 text-accent/90" title={`Touches ${n.kind} ${n.name}`}><NodeIcon /> {n.name}</span>
          ))}
          {t.agentClaimable && (
            <span className="chip bg-agent/10 text-agent" title={t.claimedByKeyId ? "Claimed by an agent" : "Agents may pick this up"}>
              {t.claimedByKeyId ? "agent working" : "AI-ready"}
            </span>
          )}
          {t.commentCount > 0 && <span className="ml-auto text-[11px] text-muted"><CommentIcon /> {t.commentCount}</span>}
        </div>
      )}
    </div>
  );
}
