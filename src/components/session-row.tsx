import clsx from "clsx";
import { timeAgo } from "@wheelhouse/core/lib/time";
import { groupByBucket, type SessionView } from "@wheelhouse/core/lib/session-buckets";

export type { SessionView };
import { Tip } from "./tip";


/** Claude Code session ids are UUIDs; the first block is enough to tell sessions apart. */
export const shortSession = (id: string) => id.split("-")[0].slice(0, 8);

/** What the row's tooltip (and its accessible label) says: everything the one-line row leaves out. */
export function sessionDetails(s: SessionView) {
  const where = [s.projectKey, s.branch && `branch ${s.branch}`].filter(Boolean).join(" · ");
  return [
    `Session ${s.id}`,
    s.ticket && `Working on ${s.ticket}`,
    where,
    `Active ${timeAgo(s.lastSeenAt)}`,
    !s.reading ? "Has not read its queue yet" : s.pending ? `${s.pending} change${s.pending === 1 ? "" : "s"} queued` : "Caught up",
  ].filter((x): x is string => !!x);
}

/** One line per session: dot, short id, and its queue. Everything else (ticket, project, branch, time) is in the tooltip; the action shows on hover or focus. */
export function SessionRow({ s, action, className }: { s: SessionView; action?: React.ReactNode; className?: string }) {
  const [title, ...rest] = sessionDetails(s);
  const status = !s.reading ? "not reading yet" : s.pending ? `${s.pending} queued` : "in sync";
  return (
    <div className={clsx("group/row flex items-center justify-between gap-3 text-xs", className)}>
      <Tip
        content={
          <div className="space-y-0.5">
            <div className="font-mono text-[11px] text-muted">{title}</div>
            {rest.map((l) => (
              <div key={l}>{l}</div>
            ))}
          </div>
        }
      >
        <span tabIndex={0} aria-label={sessionDetails(s).join(". ")} className="flex min-w-0 items-center gap-2 rounded outline-none focus-visible:ring-1 focus-visible:ring-accent/60">
          <span className={clsx("h-1.5 w-1.5 shrink-0 rounded-full", !s.reading ? "bg-muted/50" : s.pending ? "bg-agent" : "bg-ok")} aria-hidden />
          <span className="font-mono">{shortSession(s.id)}</span>
        </span>
      </Tip>
      <span className="flex shrink-0 items-center gap-2.5">
        <span className={clsx("tabular-nums", s.reading && s.pending ? "font-medium text-agent" : "text-muted")}>{status}</span>
        {action && (
          <span className="text-muted opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100">{action}</span>
        )}
      </span>
    </div>
  );
}

/** A key's sessions, grouped by how recently they were active. Groups with no sessions aren't shown. */
export function SessionGroups({ sessions, action }: { sessions: SessionView[]; action?: (s: SessionView) => React.ReactNode }) {
  const groups = groupByBucket(sessions);
  if (!groups.length) return null;
  return (
    <div className="mt-1.5 space-y-2.5 border-l border-line pl-2.5">
      {groups.map((g) => (
        <div key={g.id}>
          <div className="mb-1 text-[11px] text-muted/80">
            {g.label} <span className="text-muted/60">({g.sessions.length})</span>
          </div>
          <div className="space-y-2">
            {g.sessions.map((s) => (
              <SessionRow key={s.id} s={s} action={action?.(s)} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
