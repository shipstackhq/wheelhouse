import { useState } from "react";
import { Popover } from "radix-ui";
import clsx from "clsx";
import { NotificationsIcon } from "./icons";

type Notification = { id: string; title: string; body: string; time: string; read: boolean };

/** Placeholder content until notifications have a backend. */
const SAMPLE: Notification[] = [
  { id: "1", title: "Ticket moved to Review", body: "An agent finished work on a ticket and moved it to Review.", time: "5m ago", read: false },
  { id: "2", title: "New comment", body: "A teammate commented on a ticket you follow.", time: "1h ago", read: false },
  { id: "3", title: "Invite accepted", body: "A teammate joined the workspace.", time: "Yesterday", read: true },
];

/** The header's notifications tray. Dummy data for now: nothing is fetched and "mark all read" only changes local state. */
export function NotificationsMenu() {
  const [items, setItems] = useState(SAMPLE);
  const unread = items.filter((n) => !n.read).length;
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        className="btn relative h-8 w-8 !rounded-full p-0 text-base data-[state=open]:border-muted/60 data-[state=open]:bg-panel-2"
      >
        <NotificationsIcon />
        {unread > 0 && <span aria-hidden className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-agent" />}
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
              disabled={unread === 0}
              onClick={() => setItems((l) => l.map((n) => ({ ...n, read: true })))}
              className="text-xs text-muted outline-none hover:text-fg focus-visible:text-fg disabled:opacity-50 disabled:hover:text-muted"
            >
              Mark all read
            </button>
          </div>
          <ul className="max-h-80 divide-y divide-line overflow-y-auto">
            {items.map((n) => (
              <li key={n.id} className="flex gap-3 px-4 py-3">
                <span aria-hidden className={clsx("mt-1.5 h-2 w-2 shrink-0 rounded-full", n.read ? "bg-transparent" : "bg-agent")} />
                <div className="min-w-0">
                  <div className={clsx("text-sm", n.read ? "text-muted" : "font-medium text-fg")}>{n.title}</div>
                  <div className="text-xs text-muted">{n.body}</div>
                  <div className="mt-0.5 text-[11px] text-muted">{n.time}</div>
                </div>
              </li>
            ))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
