"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import clsx from "clsx";
import type { TicketWithLinks } from "@/lib/service";
import { createTicketAction, moveTicketAction } from "@/app/actions";
import { TicketDrawer } from "./ticket-drawer";

export type Col = { id: string; name: string };
export type NodeLite = { id: string; name: string; kind: string; parentId: string | null };
export type Member = { id: string; name: string };
type Ticket = TicketWithLinks;

export const PRIORITY_STYLE: Record<string, string> = {
  urgent: "bg-danger/20 text-danger",
  high: "bg-accent/20 text-accent",
  medium: "bg-panel-2 text-muted",
  low: "bg-panel-2 text-muted/70",
};

function group(cols: Col[], tickets: Ticket[]) {
  const m: Record<string, Ticket[]> = {};
  for (const c of cols) m[c.id] = [];
  for (const t of [...tickets].sort((a, b) => a.position - b.position)) m[t.columnId]?.push(t);
  return m;
}

export function Board(props: { projectKey: string; columns: Col[]; tickets: Ticket[]; nodes: NodeLite[]; members: Member[] }) {
  const { projectKey, columns, nodes, members } = props;
  const router = useRouter();
  const search = useSearchParams();
  const [items, setItems] = useState(() => group(columns, props.tickets));
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const dragging = useRef(false);
  const dragFrom = useRef<string | null>(null);
  const openRef = search.get("t");

  // Server state wins whenever we aren't mid-drag (live updates from agents/teammates).
  useEffect(() => {
    if (!dragging.current) setItems(group(columns, props.tickets));
  }, [columns, props.tickets]);

  const byId = useMemo(() => {
    const m = new Map<string, Ticket>();
    for (const list of Object.values(items)) for (const t of list) m.set(t.id, t);
    return m;
  }, [items]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const findCol = (id: string) => (items[id] ? id : Object.keys(items).find((c) => items[c].some((t) => t.id === id)));

  const onDragStart = (e: DragStartEvent) => {
    dragging.current = true;
    setActiveId(String(e.active.id));
    dragFrom.current = findCol(String(e.active.id)) ?? null;
  };

  const onDragOver = (e: DragOverEvent) => {
    const { active, over } = e;
    if (!over) return;
    const from = findCol(String(active.id));
    const to = findCol(String(over.id));
    if (!from || !to || from === to) return;
    setItems((prev) => {
      const moving = prev[from].find((t) => t.id === active.id)!;
      const overIdx = prev[to].findIndex((t) => t.id === over.id);
      const idx = overIdx >= 0 ? overIdx : prev[to].length;
      return {
        ...prev,
        [from]: prev[from].filter((t) => t.id !== active.id),
        [to]: [...prev[to].slice(0, idx), { ...moving, columnId: to }, ...prev[to].slice(idx)],
      };
    });
  };

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    setActiveId(null);
    const col = findCol(String(active.id));
    if (!over || !col) {
      dragging.current = false;
      return;
    }
    let list = items[col];
    const oldIdx = list.findIndex((t) => t.id === active.id);
    const overIdx = list.findIndex((t) => t.id === over.id);
    if (overIdx >= 0 && oldIdx !== overIdx) {
      list = arrayMove(list, oldIdx, overIdx);
      setItems((prev) => ({ ...prev, [col]: list }));
    }
    const finalIdx = list.findIndex((t) => t.id === active.id);
    const t = byId.get(String(active.id))!;
    const unchanged = dragFrom.current === col && oldIdx === finalIdx && overIdx < 0;
    if (unchanged) {
      dragging.current = false;
      return;
    }
    startTransition(async () => {
      const res = await moveTicketAction(t.ref, col, finalIdx);
      dragging.current = false;
      if (!res.ok) setError(res.error);
      router.refresh();
    });
  };

  const openTicket = (ref: string | null) => {
    const sp = new URLSearchParams(search.toString());
    if (ref) sp.set("t", ref);
    else sp.delete("t");
    router.replace(`?${sp.toString()}`, { scroll: false });
  };

  const active = activeId ? byId.get(activeId) : null;

  return (
    <div className="flex h-full">
      <div className="min-w-0 flex-1 overflow-x-auto">
        {error && (
          <div className="mx-5 mt-3 flex items-center justify-between rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
            <button onClick={() => setError(null)}>✕</button>
          </div>
        )}
        <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd}>
          <div className="flex h-full gap-3 p-4">
            {columns.map((c) => (
              <Column
                key={c.id}
                col={c}
                tickets={items[c.id] ?? []}
                nodes={nodes}
                onOpen={openTicket}
                selected={openRef}
                projectKey={projectKey}
                onCreated={() => router.refresh()}
              />
            ))}
          </div>
          <DragOverlay>{active ? <Card t={active} nodes={nodes} overlay /> : null}</DragOverlay>
        </DndContext>
      </div>
      {openRef && (
        <TicketDrawer
          key={openRef}
          ticketRef={openRef}
          projectKey={projectKey}
          columns={columns}
          nodes={nodes}
          members={members}
          onClose={() => openTicket(null)}
        />
      )}
    </div>
  );
}

function Column(props: {
  col: Col;
  tickets: Ticket[];
  nodes: NodeLite[];
  selected: string | null;
  projectKey: string;
  onOpen: (ref: string) => void;
  onCreated: () => void;
}) {
  const { col, tickets } = props;
  const { setNodeRef, isOver } = useDroppable({ id: col.id });
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [pending, start] = useTransition();

  const submit = () => {
    if (!title.trim()) return setAdding(false);
    start(async () => {
      await createTicketAction(props.projectKey, { title, column: col.id });
      setTitle("");
      props.onCreated();
    });
  };

  return (
    <div className={clsx("flex w-72 shrink-0 flex-col rounded-lg bg-panel/60", isOver && "ring-1 ring-accent/40")}>
      <div className="flex items-center justify-between px-3 py-2.5">
        <span className="text-sm font-medium">{col.name}</span>
        <span className="text-xs text-muted">{tickets.length}</span>
      </div>
      <div ref={setNodeRef} className="flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        <SortableContext items={tickets.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {tickets.map((t) => (
            <SortableCard key={t.id} t={t} nodes={props.nodes} selected={props.selected === t.ref} onOpen={props.onOpen} />
          ))}
        </SortableContext>
        {adding ? (
          <textarea
            autoFocus
            className="input resize-none"
            rows={2}
            placeholder="Ticket title, Enter to add"
            value={title}
            disabled={pending}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={submit}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
              if (e.key === "Escape") setAdding(false);
            }}
          />
        ) : (
          <button className="rounded-md px-2 py-1.5 text-left text-sm text-muted hover:bg-panel-2 hover:text-fg" onClick={() => setAdding(true)}>
            + Add ticket
          </button>
        )}
      </div>
    </div>
  );
}

function SortableCard({ t, nodes, selected, onOpen }: { t: Ticket; nodes: NodeLite[]; selected: boolean; onOpen: (ref: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: t.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      onClick={() => onOpen(t.ref)}
      className={clsx(isDragging && "opacity-30")}
    >
      <Card t={t} nodes={nodes} selected={selected} />
    </div>
  );
}

function Card({ t, nodes, selected, overlay }: { t: Ticket; nodes: NodeLite[]; selected?: boolean; overlay?: boolean }) {
  const linked = t.nodeIds.map((id) => nodes.find((n) => n.id === id)).filter(Boolean) as NodeLite[];
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
          {t.createdByKind === "agent" && <span className="chip bg-agent/15 text-agent" title="Created by an agent">🤖</span>}
          {t.priority !== "medium" && <span className={clsx("chip", PRIORITY_STYLE[t.priority])}>{t.priority}</span>}
        </div>
      </div>
      <div className="mt-1 leading-snug">{t.title}</div>
      {(t.labels.length > 0 || linked.length > 0 || t.commentCount > 0 || t.agentClaimable) && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {t.labels.map((l) => (
            <span key={l} className="chip bg-bg text-muted">{l}</span>
          ))}
          {linked.map((n) => (
            <span key={n.id} className="chip bg-accent/10 text-accent/90" title={`Touches ${n.kind} ${n.name}`}>◇ {n.name}</span>
          ))}
          {t.agentClaimable && (
            <span className="chip bg-agent/10 text-agent" title={t.claimedByKeyId ? "Claimed by an agent" : "Agents may pick this up"}>
              {t.claimedByKeyId ? "agent working" : "AI-ready"}
            </span>
          )}
          {t.commentCount > 0 && <span className="ml-auto text-[11px] text-muted">💬 {t.commentCount}</span>}
        </div>
      )}
    </div>
  );
}
