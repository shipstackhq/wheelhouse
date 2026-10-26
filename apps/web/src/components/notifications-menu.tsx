import { useState } from "react";
import { Link } from "../lib/workspace";
import { Popover } from "radix-ui";
import clsx from "clsx";
import { timeAgo } from "@wheelhouse/shared/time";
import { BELL_ITEMS, useInbox, useInboxActions, useOpenItem, useUnreadCount } from "../lib/notifications";
import { NotificationsIcon } from "./icons";

/** The header's notifications tray: the latest few inbox items, with the same unread count and actions as the Inbox page. */
export function NotificationsMenu() {
  const [open, setOpen] = useState(false);
  const unread = useUnreadCount().data ?? 0;
  const query = useInbox(false, BELL_ITEMS);
  const { markAllRead } = useInboxActions();
  const openItem = useOpenItem();
  const items = query.data?.pages[0]?.items ?? [];
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        className="btn btn-ghost relative h-8 w-8 !rounded-full p-0 text-base data-[state=open]:bg-panel-2 data-[state=open]:text-fg"
      >
        <NotificationsIcon />
        {unread > 0 && <span aria-hidden data-testid="bell-dot" className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-agent" />}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          collisionPadding={8}
          className="z-50 w-80 max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg border border-line bg-panel text-fg shadow-xl"
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <div>
              <div className="text-sm font-medium">Notifications</div>
              <div className="text-xs text-muted">{unread ? `${unread} unread` : "All caught up"}</div>
            </div>
            <button
              type="button"
              disabled={unread === 0 || markAllRead.isPending}
              onClick={() => markAllRead.mutate()}
              className="text-xs text-muted outline-none hover:text-fg focus-visible:text-fg disabled:opacity-50 disabled:hover:text-muted"
            >
              Mark all read
            </button>
          </div>
          {query.isError ? (
            <p role="alert" className="px-4 py-3 text-xs text-danger">Could not load notifications.</p>
          ) : query.isPending ? (
            <div role="status" aria-busy="true" className="px-4 py-3 text-xs text-muted">Loading…</div>
          ) : (
            <ul className="max-h-80 divide-y divide-line overflow-y-auto">
              {items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      openItem(n);
                    }}
                    className="flex w-full gap-3 px-4 py-3 text-left outline-none hover:bg-panel-2 focus-visible:bg-panel-2"
                  >
                    <span aria-hidden className={clsx("mt-1.5 h-2 w-2 shrink-0 rounded-full", n.readAt ? "bg-transparent" : "bg-agent")} />
                    <span className="min-w-0">
                      <span className={clsx("block text-sm", n.readAt ? "text-muted" : "font-medium text-fg")}>{n.title}</span>
                      {n.body && <span className="block truncate text-xs text-muted">{n.body}</span>}
                      <span className="mt-0.5 block text-[11px] text-muted">{timeAgo(n.createdAt)}</span>
                    </span>
                  </button>
                </li>
              ))}
              {items.length === 0 && <li className="px-4 py-3 text-xs text-muted">Nothing here yet.</li>}
            </ul>
          )}
          <Link to="/inbox" onClick={() => setOpen(false)} className="block border-t border-line px-4 py-2 text-center text-xs text-muted outline-none hover:text-fg focus-visible:text-fg">
            View all
          </Link>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
