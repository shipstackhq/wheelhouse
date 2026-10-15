import clsx from "clsx";
import { timeAgo } from "@/lib/time";
import { List } from "./list";
import { SessionGroups, type SessionView } from "./session-row";
import { SubmitButton } from "./submit-button";

/** `sessions`: active client sessions on this key; with any, `pending` is the key's queue as seen by its recent sessions. */
export type Bot = { id: string; name: string; pending: number; sessions: SessionView[]; lastUsedAt: string | null };

/**
 * The popover's list: one line per bot (name, queue), a muted line under it (seen, session count) and its sessions.
 * Actions are passed in so this stays presentational: "mark all seen" appears on hover/focus, never as permanent clutter.
 */
export function BotsList({
  projectKey,
  bots,
  markAllSeen,
  sessionAction,
}: {
  projectKey: string;
  bots: Bot[];
  markAllSeen: (formData: FormData) => void | Promise<void>;
  sessionAction?: (s: SessionView) => React.ReactNode;
}) {
  return (
    <List inset="flush" className="max-h-72 overflow-y-auto overflow-x-hidden text-sm">
      {bots.map((b) => (
        <li key={b.id} className="group/bot">
          <div className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2">
              <span className={clsx("h-2 w-2 shrink-0 rounded-full", b.pending ? "bg-agent" : "bg-ok")} aria-hidden />
              <span className="truncate font-medium">{b.name}</span>
            </span>
            <span className={clsx("shrink-0 text-xs tabular-nums", b.pending ? "font-medium text-agent" : "text-muted")}>{b.pending ? `${b.pending} queued` : "in sync"}</span>
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-3 pl-4 text-xs text-muted">
            <span className="truncate">
              {b.lastUsedAt ? `seen ${timeAgo(b.lastUsedAt)}` : "never connected"}
              {b.sessions.length > 0 && ` · ${b.sessions.length} session${b.sessions.length === 1 ? "" : "s"}`}
            </span>
            {b.pending > 0 && (
              <form
                action={markAllSeen}
                className="shrink-0 opacity-0 transition-opacity group-focus-within/bot:opacity-100 group-hover/bot:opacity-100 [@media(hover:none)]:opacity-100"
              >
                <input type="hidden" name="keyId" value={b.id} />
                <input type="hidden" name="project" value={projectKey} />
                <SubmitButton className="underline-offset-2 hover:text-fg hover:underline" title="Mark everything as seen for this agent in this project">
                  mark all seen
                </SubmitButton>
              </form>
            )}
          </div>
          <div className="pl-2">
            <SessionGroups sessions={b.sessions} action={sessionAction} />
          </div>
        </li>
      ))}
    </List>
  );
}
