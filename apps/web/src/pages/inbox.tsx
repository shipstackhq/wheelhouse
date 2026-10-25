import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { Popover } from "radix-ui";
import clsx from "clsx";
import { timeAgo } from "@wheelhouse/shared/time";
import { ArchiveIcon, ChevronDownIcon, ChevronLeftIcon, FilterIcon, MailIcon, RestoreIcon, TrashIcon, UnarchiveIcon } from "../components/icons";
import { Markdown } from "../components/markdown";
import { errorText } from "../components/query-state";
import { Skeleton } from "../components/skeleton";
import { plainSnippet, useInbox, useInboxActions, useUnreadCount, type InboxItem, type InboxView } from "../lib/notifications";

/** The switchers and "Mark all read" share this height so they cannot drift apart. */
const BAR_H = "h-6";

const VIEWS: { view: InboxView; label: string }[] = [
  { view: "inbox", label: "Inbox" },
  { view: "archived", label: "Archived" },
  { view: "trash", label: "Trash" },
];

/** What a row or the reader offers in each view: the inbox sets items aside or deletes them, Archived gives them back or deletes, Trash only restores. */
type Action = "archive" | "unarchive" | "delete" | "restore";
const ACTIONS: Record<InboxView, Action[]> = { inbox: ["archive", "delete"], archived: ["unarchive", "delete"], trash: ["restore"] };
const ACTION_LABEL: Record<Action, string> = { archive: "Archive", unarchive: "Unarchive", delete: "Delete", restore: "Restore" };
const ACTION_ICON: Record<Action, typeof ArchiveIcon> = { archive: ArchiveIcon, unarchive: UnarchiveIcon, delete: TrashIcon, restore: RestoreIcon };

/** The view the URL names (?view=archived or ?view=trash); anything else is the inbox. */
const viewOf = (raw: string | null): InboxView => (raw === "archived" || raw === "trash" ? raw : "inbox");

const DAY = 24 * 60 * 60 * 1000;
/** "Deleted · removed in N days", counted from purgeAt. Zero or fewer days left (or a purge date that has passed) reads "removed today". */
function removedNote(purgeAt: string | null, now = Date.now()): string {
  const at = purgeAt ? new Date(purgeAt).getTime() : NaN;
  if (!Number.isFinite(at)) return "Deleted";
  const days = Math.ceil((at - now) / DAY);
  if (days <= 0) return "Deleted · removed today";
  if (days === 1) return "Deleted · removed in 1 day";
  return `Deleted · removed in ${days} days`;
}

/** The view picker: the trigger names the current view, and the list picks another and closes. */
function ViewFilter({ view, onPick }: { view: InboxView; onPick: (v: InboxView) => void }) {
  const [open, setOpen] = useState(false);
  const label = VIEWS.find((v) => v.view === view)?.label ?? "Inbox";
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger aria-label={`Filter: ${label}`} className={clsx("btn gap-1 px-2 py-0 text-xs", BAR_H)}>
        <FilterIcon /> {label} <ChevronDownIcon />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} collisionPadding={8} className="z-50 w-40 rounded-lg border border-line bg-panel p-1 text-sm text-fg shadow-xl">
          {VIEWS.map(({ view: v, label: l }) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => {
                onPick(v);
                setOpen(false);
              }}
              className={clsx("flex w-full items-center rounded px-2 py-1.5 text-left hover:bg-panel-2", view === v && "font-medium text-fg")}
            >
              {l}
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function emptyText(view: InboxView, unreadOnly: boolean): { title: string; detail?: string } {
  if (view === "archived") return { title: "No archived notifications" };
  if (view === "trash") return { title: "Trash is empty", detail: "Deleted notifications are removed after 30 days." };
  return { title: "All caught up", detail: unreadOnly ? "Nothing unread." : "Nothing has come in yet." };
}

/** The list column's width, dragged or keyed at md and up. Kept in localStorage so it survives a reload. */
const LIST = { key: "wh:inbox:list-width", min: 280, max: 560, initial: 384, step: 16 } as const;

const clampWidth = (n: number) => Math.min(LIST.max, Math.max(LIST.min, Math.round(n)));

function readWidth(): number {
  try {
    const raw = localStorage.getItem(LIST.key);
    if (raw !== null && raw.trim() !== "" && Number.isFinite(Number(raw))) return clampWidth(Number(raw));
  } catch {
    /* no storage (private mode, blocked): the default width */
  }
  return LIST.initial;
}

function saveWidth(width: number) {
  try {
    localStorage.setItem(LIST.key, String(width));
  } catch {
    /* no storage: the width still holds for this visit */
  }
}

/**
 * `/inbox`: the signed-in person's notifications, newest first, as a mail reader. The list is on the left; the one picked (`?n=<id>`)
 * opens on the right. Picking marks it read and stays here; "Open issue" is the only thing that goes elsewhere. Below md it is one column.
 * `?view=archived` and `?view=trash` show the other two lists; the inbox is the default and has no `view` in the URL.
 * At md and up the divider between the two columns can be dragged or moved with the arrow keys.
 */
export function InboxPage() {
  const [listWidth, setListWidth] = useState(readWidth);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const resize = (width: number) => {
    const next = clampWidth(width);
    setListWidth(next);
    saveWidth(next);
  };
  const onDividerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, width: listWidth };
    setDragging(true);
  };
  const onDividerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) resize(drag.current.width + e.clientX - drag.current.x);
  };
  const onDividerEnd = () => {
    drag.current = null;
    setDragging(false);
  };
  const onDividerKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    resize(listWidth + (e.key === "ArrowRight" ? LIST.step : -LIST.step));
  };

  const [unreadOnly, setUnreadOnly] = useState(false);
  const [params, setParams] = useSearchParams();
  const view = viewOf(params.get("view"));
  // The Unread filter is an inbox control only: the other two views always show everything.
  const query = useInbox(unreadOnly && view === "inbox", undefined, view);
  const unread = useUnreadCount().data ?? 0;
  const { markRead, markAllRead, archive, unarchive, remove, restore } = useInboxActions();
  const mutations = { archive, unarchive, delete: remove, restore };
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const selectedId = params.get("n");
  // Reading an item in the Unread view takes it out of that list; keep showing it until something else is picked.
  const lastSeen = useRef<InboxItem | null>(null);
  const found = items.find((n) => n.id === selectedId) ?? null;
  if (found) lastSeen.current = found;
  const selected = found ?? (unreadOnly && view === "inbox" && selectedId && lastSeen.current?.id === selectedId ? lastSeen.current : null);
  const listRef = useRef<HTMLUListElement>(null);
  const empty = emptyText(view, unreadOnly);

  /** Change the URL's params, keeping the ones this does not name (the view survives a selection). */
  const update = (change: (p: URLSearchParams) => void, options?: { replace?: boolean }) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      change(next);
      return next;
    }, options);
  // Trashed items are not read or unread any more, so picking one there does not mark it read.
  const select = (n: InboxItem) => {
    if (!n.readAt && view !== "trash") markRead.mutate(n.id);
    update((p) => p.set("n", n.id));
  };
  const clear = () => update((p) => p.delete("n"), { replace: true });
  const switchView = (next: InboxView) =>
    update((p) => {
      p.delete("n");
      if (next === "inbox") p.delete("view");
      else p.set("view", next);
    });
  /** Every action takes the item out of the view it is in, so a selection on it is cleared. */
  const act = (action: Action, id: string) => {
    mutations[action].mutate(id);
    if (id === selectedId) clear();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const at = items.findIndex((n) => n.id === selectedId);
    const next = items[e.key === "ArrowDown" ? Math.min(items.length - 1, at + 1) : Math.max(0, at - 1)];
    if (!next) return;
    e.preventDefault();
    select(next);
    listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(next.id)}"]`)?.focus();
  };

  return (
    <div className="flex h-full">
      <section
        aria-label="Notifications"
        style={{ "--inbox-list-w": `${listWidth}px` } as CSSProperties}
        className={clsx("min-h-0 w-full flex-col border-r border-line md:border-r-0 md:flex md:w-(--inbox-list-w) md:shrink-0", selected ? "hidden" : "flex")}
      >
        <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
          <ViewFilter view={view} onPick={switchView} />
          {view === "inbox" && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                title="Unread only"
                aria-pressed={unreadOnly}
                onClick={() => setUnreadOnly(!unreadOnly)}
                className={clsx(
                  "inline-flex h-6 w-6 items-center justify-center rounded-full border outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
                  unreadOnly ? "border-accent/60 bg-accent/10 text-fg" : "border-line text-muted hover:text-fg",
                )}
              >
                <MailIcon className="text-sm" />
              </button>
              <button type="button" className={clsx("btn px-2 py-0 text-xs", BAR_H)} disabled={unread === 0 || markAllRead.isPending} onClick={() => markAllRead.mutate()}>
                Mark all read
              </button>
            </div>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {query.isPending ? (
            <div role="status" aria-busy="true" aria-live="polite" className="divide-y divide-line">
              <span className="sr-only">Loading the inbox…</span>
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-12 w-full !rounded-none" />
              ))}
            </div>
          ) : query.isError ? (
            <div role="alert" className="p-3">
              <p className="text-sm text-danger">{errorText(query.error)}</p>
              <button type="button" className="btn mt-2" onClick={() => void query.refetch()}>Try again</button>
            </div>
          ) : items.length === 0 ? (
            <div className="mt-12 text-center">
              <p className="text-sm font-medium">{empty.title}</p>
              {empty.detail && <p className="mt-1 text-sm text-muted">{empty.detail}</p>}
            </div>
          ) : (
            <>
              <ul ref={listRef} onKeyDown={onKeyDown} className="divide-y divide-line">
                {items.map((n) => (
                  <Row key={n.id} item={n} view={view} selected={n.id === selected?.id} onSelect={() => select(n)} onAct={(a) => act(a, n.id)} />
                ))}
              </ul>
              {query.hasNextPage && (
                <button type="button" className="btn m-2 mx-auto flex" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                  Load more
                </button>
              )}
            </>
          )}
        </div>
      </section>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the notification list"
        aria-valuenow={listWidth}
        aria-valuemin={LIST.min}
        aria-valuemax={LIST.max}
        tabIndex={0}
        data-dragging={dragging || undefined}
        onPointerDown={onDividerDown}
        onPointerMove={onDividerMove}
        onPointerUp={onDividerEnd}
        onPointerCancel={onDividerEnd}
        onKeyDown={onDividerKey}
        className="relative hidden w-px shrink-0 cursor-col-resize touch-none bg-line outline-none before:absolute before:inset-y-0 before:-inset-x-1.5 before:content-[''] hover:bg-accent focus-visible:bg-accent data-dragging:bg-accent md:block"
      />

      <section aria-label="Notification" className={clsx("min-w-0 flex-1 overflow-y-auto md:block", selected ? "block" : "hidden")}>
        {selected ? (
          <Detail key={selected.id} item={selected} view={view} onBack={clear} onAct={(a) => act(a, selected.id)} />
        ) : (
          <p className="mt-16 text-center text-sm text-muted">Select a notification</p>
        )}
      </section>
    </div>
  );
}

function Row({ item: n, view, selected, onSelect, onAct }: { item: InboxItem; view: InboxView; selected: boolean; onSelect: () => void; onAct: (a: Action) => void }) {
  // Read state only matters in the inbox: a row elsewhere is never drawn as unread.
  const unread = view === "inbox" && !n.readAt;
  return (
    <li data-unread={unread || undefined} className={clsx("group relative hover:bg-panel-2", selected ? "bg-accent/10" : unread && "bg-panel")}>
      {/* The whole card selects; the content above passes clicks through, and the action buttons take their own. */}
      <button
        type="button"
        data-id={n.id}
        aria-label={n.title}
        aria-current={selected || undefined}
        onClick={onSelect}
        className="absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50"
      />
      <div className="pointer-events-none relative flex gap-2 px-3 py-2">
        <span aria-hidden className={clsx("mt-1.5 h-2 w-2 shrink-0 rounded-full", unread ? "bg-accent" : "bg-transparent")} />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="flex items-center gap-2">
            <span className={clsx("min-w-0 flex-1 truncate text-sm", unread ? "font-medium text-fg" : "text-muted")}>{n.title}</span>
            {/* Hover or keyboard focus only: the row stays calm until someone reaches for it. */}
            <span className="pointer-events-auto -my-1 flex shrink-0 gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
              {ACTIONS[view].map((a) => {
                const Icon = ACTION_ICON[a];
                return (
                  <button
                    key={a}
                    type="button"
                    title={ACTION_LABEL[a]}
                    aria-label={`${ACTION_LABEL[a]}: ${n.title}`}
                    onClick={() => onAct(a)}
                    className="rounded p-1 text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50"
                  >
                    <Icon className="text-base" />
                  </button>
                );
              })}
            </span>
          </span>
          <span className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate text-xs text-muted">{view === "trash" ? removedNote(n.purgeAt) : (n.bodyFormat === "markdown" ? plainSnippet(n.body) : n.body) || n.actor?.name}</span>
            <span className="shrink-0 text-[11px] text-muted">{timeAgo(n.createdAt)}</span>
          </span>
        </span>
      </div>
    </li>
  );
}

function Detail({ item: n, view, onBack, onAct }: { item: InboxItem; view: InboxView; onBack: () => void; onAct: (a: Action) => void }) {
  return (
    <article className="mx-auto w-full max-w-3xl px-4 py-3">
      <button type="button" onClick={onBack} className="btn mb-2 md:hidden">
        <ChevronLeftIcon /> Back
      </button>
      <h2 className="text-lg font-semibold">{n.title}</h2>
      <p className="mt-0.5 text-xs text-muted">
        {n.actor?.name ? `${n.actor.name} · ` : ""}
        <time dateTime={n.createdAt} title={new Date(n.createdAt).toLocaleString()}>{timeAgo(n.createdAt)}</time>
        {n.subject ? ` · About: ${n.subject.entity}` : ""}
      </p>
      {n.body && (n.bodyFormat === "markdown" ? (
        <div className="mt-3 text-sm"><Markdown>{n.body}</Markdown></div>
      ) : (
        <p className="mt-3 whitespace-pre-wrap text-sm">{n.body}</p>
      ))}
      {view === "trash" && <p className="mt-3 text-xs text-muted">{removedNote(n.purgeAt)}</p>}
      <div className="mt-4 flex items-center gap-2">
        {n.href && (
          <Link to={n.href} className="btn btn-primary">
            Open issue
          </Link>
        )}
        {ACTIONS[view].map((a) => {
          const Icon = ACTION_ICON[a];
          return (
            <button key={a} type="button" className="btn" onClick={() => onAct(a)}>
              <Icon /> {ACTION_LABEL[a]}
            </button>
          );
        })}
      </div>
    </article>
  );
}
