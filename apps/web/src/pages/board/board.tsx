import { useEffect, useMemo, useRef, useState } from "react";
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
import type { CycleOption } from "@wheelhouse/api-client";
import { describeFailure } from "../../lib/form-state";
import { useServices } from "../../lib/services";
import { neighbours, parseTicketParam } from "../../lib/ticket-nav";
import { dragOver, drop, findCol, group, type Items } from "./board-state";
import { ColumnControls, EMPTY_VIEW, applyView, describeSort, isFiltered, loadView, matches, saveView, type View } from "./column-controls";
import { PRIORITY_STYLE, type Col, type Member, type NodeLite, type Ticket } from "./shared";
import { TicketDialog } from "./ticket-dialog";
import { AgentIcon, CloseIcon, CommentIcon, CyclesIcon, NodeIcon } from "../../components/icons";
import { cycleTitle } from "../cycles/cycle-bits";

/**
 * The kanban board. What is on screen is a local copy of the server's tickets, so a drag can move cards at once. The server's
 * copy replaces it whenever nothing is being dragged (that is how a teammate's or an agent's change shows up), and again, with the
 * real positions, when a drop has been saved.
 */
const NO_CYCLES: CycleOption[] = [];

export function Board(props: { teamKey: string; columns: Col[]; tickets: Ticket[]; nodes: NodeLite[]; members: Member[]; cycles?: CycleOption[] }) {
  const { teamKey, columns, nodes, members } = props;
  const cycles = props.cycles ?? NO_CYCLES;
  const { api, queryClient } = useServices();
  const [search, setSearch] = useSearchParams();
  const [items, setItems] = useState<Items>(() => group(columns, props.tickets));
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dragging = useRef(false);
  const dragFrom = useRef<string | null>(null);
  const [views, setViews] = useState<Record<string, View>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const viewKey = (colId: string) => `wh:view:${teamKey}:${colId}`;
  const viewOf = (colId: string) => views[colId] ?? EMPTY_VIEW;
  // ?t= is the source of truth for the open ticket; a value that isn't a ticket ref is ignored.
  const openRef = parseTicketParam(search.get("t"));

  const refreshBoard = () => queryClient.invalidateQueries({ queryKey: ["board", teamKey] });

  // Server state wins whenever we aren't mid-drag (live updates from agents/teammates).
  useEffect(() => {
    if (!dragging.current) setItems(group(columns, props.tickets));
  }, [columns, props.tickets]);

  // Restore each column's filter/sort when the team or its columns change.
  // Keyed on the column ids, not the array: a refresh hands over a new array, and reloading here would give each Column a fresh
  // view object and un-pin tickets it just added.
  const columnIds = columns.map((c) => c.id).join(",");
  useEffect(() => {
    setViews(Object.fromEntries(columns.map((c) => [c.id, loadView(viewKey(c.id))])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamKey, columnIds]);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(id);
  }, [notice]);

  const changeView = (colId: string, v: View) => {
    setViews((prev) => ({ ...prev, [colId]: v }));
    saveView(viewKey(colId), v);
  };

  const labels = useMemo(() => [...new Set(props.tickets.flatMap((t) => t.labels))].sort(), [props.tickets]);

  const byId = useMemo(() => {
    const m = new Map<string, Ticket>();
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
    setItems((prev) => dragOver(prev, String(active.id), String(over.id)));
  };

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    setActiveId(null);
    const result = drop(items, String(active.id), over ? String(over.id) : null, dragFrom.current, (col) => !!viewOf(col).sort);
    setItems(result.items);
    if (!result.move) {
      dragging.current = false;
      return;
    }
    const { columnId, index, crossed } = result.move;
    const t = byId.get(String(active.id))!;
    const target = viewOf(columnId);
    if (crossed && isFiltered(target) && !matches(t, target)) {
      setNotice(`${t.ref} moved to ${columns.find((c) => c.id === columnId)?.name}, but the column filter hides it.`);
    }
    void (async () => {
      try {
        await api.tickets.move(t.ref, { column: columnId, index });
      } catch (err) {
        setError(describeFailure(err));
      } finally {
        dragging.current = false;
        await refreshBoard(); // the server's positions replace the local ones (and undo a move the server refused)
      }
    })();
  };

  const openTicket = (ref: string | null) => {
    const sp = new URLSearchParams(search);
    if (ref) sp.set("t", ref);
    else sp.delete("t");
    setSearch(sp, { replace: true, preventScrollReset: true });
  };

  const active = activeId ? byId.get(activeId) : null;

  // Previous/next in the dialog walk the open ticket's column in the order the board shows it (filter and sort applied);
  // if a filter hides the open ticket, fall back to the whole column.
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
          <div className="flex h-full gap-3 p-4">
            {columns.map((c) => (
              <Column
                key={c.id}
                col={c}
                tickets={items[c.id] ?? []}
                view={viewOf(c.id)}
                onViewChange={(v) => changeView(c.id, v)}
                members={members}
                labels={labels}
                cycles={cycles}
                nodes={nodes}
                onOpen={openTicket}
                selected={openRef}
                teamKey={teamKey}
                onCreated={() => void refreshBoard()}
              />
            ))}
          </div>
          <DragOverlay>{active ? <Card t={active} nodes={nodes} cycles={cycles} overlay /> : null}</DragOverlay>
        </DndContext>
      </div>
      {openRef && (
        <TicketDialog
          key={openRef}
          ticketRef={openRef}
          teamKey={teamKey}
          columns={columns}
          nodes={nodes}
          members={members}
          cycles={cycles}
          nav={nav}
          onNavigate={openTicket}
          onClose={() => openTicket(null)}
        />
      )}
    </div>
  );
}

function Column(props: {
  col: Col;
  tickets: Ticket[];
  view: View;
  onViewChange: (v: View) => void;
  members: Member[];
  labels: string[];
  cycles: CycleOption[];
  nodes: NodeLite[];
  selected: string | null;
  teamKey: string;
  onOpen: (ref: string) => void;
  onCreated: () => void;
}) {
  const { api } = useServices();
  const { col, view } = props;
  const { setNodeRef, isOver } = useDroppable({ id: col.id });
  // Tickets that arrive after "+ Add ticket" stay visible despite the filter, so the add doesn't look like it failed.
  const [pinFrom, setPinFrom] = useState<Set<string> | null>(null);
  const tickets = useMemo(
    () => applyView(props.tickets, view, pinFrom ? (t) => !pinFrom.has(t.id) : undefined),
    [props.tickets, view, pinFrom],
  );
  useEffect(() => setPinFrom(null), [view]);
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
    if (isFiltered(view)) setPinFrom((prev) => prev ?? new Set(props.tickets.map((t) => t.id)));
    setTitle("");
    if (!keepOpen) setAdding(false);
    void (async () => {
      try {
        await api.tickets.create(props.teamKey, { title: value, column: col.id });
        props.onCreated();
      } catch {
        props.onCreated(); // whatever happened, show the board as the server has it
      } finally {
        submitting.current = false;
      }
    })();
  };

  return (
    <div className={clsx("flex w-72 shrink-0 flex-col rounded-lg bg-panel/60", isOver && "ring-1 ring-accent/40")} data-column={col.id}>
      <div className="group/head flex items-center justify-between gap-2 px-3 py-2.5">
        <span className="text-sm font-medium">{col.name}</span>
        <div className="flex min-w-0 items-center gap-2">
          <ColumnControls view={view} onChange={props.onViewChange} members={props.members} labels={props.labels} cycles={props.cycles} />
          <span className="shrink-0 text-xs text-muted">
            {tickets.length === props.tickets.length ? tickets.length : `${tickets.length} of ${props.tickets.length}`}
          </span>
        </div>
      </div>
      {view.sort && <div className="px-3 pb-1 text-[11px] text-muted">sorted by {describeSort(view)}; drag order is off</div>}
      <div ref={setNodeRef} className="flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        <SortableContext items={tickets.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {tickets.map((t) => (
            <SortableCard key={t.id} t={t} nodes={props.nodes} cycles={props.cycles} selected={props.selected === t.ref} onOpen={props.onOpen} />
          ))}
        </SortableContext>
        {adding ? (
          <textarea
            autoFocus
            className="input resize-none"
            rows={2}
            aria-label={`New ticket in ${col.name}`}
            placeholder="Ticket title, Enter to add"
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
            + Add ticket
          </button>
        )}
      </div>
    </div>
  );
}

function SortableCard({ t, nodes, cycles, selected, onOpen }: { t: Ticket; nodes: NodeLite[]; cycles: CycleOption[]; selected: boolean; onOpen: (ref: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: t.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      onClick={() => onOpen(t.ref)}
      className={clsx(isDragging && "opacity-30")}
      data-ticket={t.ref}
    >
      <Card t={t} nodes={nodes} cycles={cycles} selected={selected} />
    </div>
  );
}

function Card({ t, nodes, cycles, selected, overlay }: { t: Ticket; nodes: NodeLite[]; cycles: CycleOption[]; selected?: boolean; overlay?: boolean }) {
  const linked = t.nodeIds.map((id) => nodes.find((n) => n.id === id)).filter(Boolean) as NodeLite[];
  const cycle = t.cycle == null ? null : (cycles.find((c) => c.number === t.cycle) ?? { number: t.cycle, name: "", startsAt: "", endsAt: "", state: "current" as const });
  return (
    <div
      className={clsx(
        "cursor-grab rounded-md border bg-panel-2 p-2.5 text-sm shadow-sm active:cursor-grabbing",
        selected ? "border-accent" : "border-line hover:border-muted/50",
        overlay && "rotate-2 shadow-xl",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-[11px] text-muted">{t.ref}</span>
        <div className="flex gap-1">
          {t.createdByKind === "agent" && <span className="chip bg-agent/15 text-agent" title="Created by an agent"><AgentIcon /></span>}
          {t.priority !== "medium" && <span className={clsx("chip", PRIORITY_STYLE[t.priority])}>{t.priority}</span>}
        </div>
      </div>
      <div className="mt-1 leading-snug">{t.title}</div>
      {(t.labels.length > 0 || linked.length > 0 || t.commentCount > 0 || t.agentClaimable || cycle) && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
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
