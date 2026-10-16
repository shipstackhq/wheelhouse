"use client";

import { useState } from "react";
import clsx from "clsx";
import { timeAgo } from "@wheelhouse/core/lib/time";
import { groupHistory, type HistoryGroup } from "@/lib/history-groups";

export type HistoryItem = { seq: number; actorKind: "human" | "agent"; actorName: string; summary: string; createdAt: Date | string };

const HISTORY_PREVIEW = 10;

/** Keep the first `budget` lines across the groups (newest first); a group keeps its full size for its count. */
function visibleLines(groups: HistoryGroup<HistoryItem>[], budget: number) {
  const out: { group: HistoryGroup<HistoryItem>; shown: HistoryItem[] }[] = [];
  let left = budget;
  for (const group of groups) {
    if (left <= 0) break;
    const shown = group.items.slice(0, left);
    left -= shown.length;
    out.push({ group, shown });
  }
  return out;
}

/**
 * Ticket history, newest first. Consecutive changes by the same doer sit under one heading, so the name is
 * written once instead of on every line. Shows the latest ten changes; "show more" opens a scrollable list of everything.
 * The count beside a doer's name is that run's real total, whether or not all of its lines are showing yet.
 */
export function HistoryList({ items, defaultExpanded = false }: { items: HistoryItem[]; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  if (!items.length) return <p className="text-xs text-muted">No history yet.</p>;
  const hidden = Math.max(0, items.length - HISTORY_PREVIEW);
  // Group everything first, then decide how many lines to show: grouping only the visible ten would make the count beside a name say 10.
  const groups = visibleLines(groupHistory(items), expanded ? Infinity : HISTORY_PREVIEW);

  const list = (
    <ul className="space-y-3 text-xs">
      {groups.map(({ group: g, shown }) => {
        const headTime = timeAgo(g.newestAt);
        const agent = g.actorKind === "agent";
        return (
          <li key={g.items[0].seq}>
            <div className="flex items-baseline gap-2">
              <span className={clsx("min-w-0 truncate font-medium", agent ? "text-agent" : "text-fg")} title={g.actorName}>
                {agent ? "🤖 " : ""}
                {g.actorName}
              </span>
              {g.items.length > 1 && (
                <span className="shrink-0 text-muted/70">
                  {g.items.length} changes
                </span>
              )}
              <span className="ml-auto shrink-0 text-muted/70">{headTime}</span>
            </div>
            <ul className="mt-1 space-y-1 border-l border-line pl-2.5">
              {shown.map((h) => {
                const t = timeAgo(h.createdAt);
                return (
                  <li key={h.seq} className="flex gap-2 text-muted">
                    <span className="min-w-0 break-words">{h.summary}</span>
                    {t !== headTime && <span className="ml-auto shrink-0 text-muted/70">{t}</span>}
                  </li>
                );
              })}
            </ul>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div>
      {/* Expanded, the list scrolls in place: bounded height, but no box of its own (no background, border or padding). */}
      {expanded ? <div className="max-h-64 overflow-y-auto overflow-x-hidden">{list}</div> : list}
      {hidden > 0 && (
        <button className="mt-2 text-xs text-muted hover:text-fg" onClick={() => setExpanded((e) => !e)}>
          {expanded ? "Show less" : `Show ${hidden} more`}
        </button>
      )}
    </div>
  );
}
