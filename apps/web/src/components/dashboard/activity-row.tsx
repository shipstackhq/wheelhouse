import { timeAgo } from "@wheelhouse/core/lib/time";
import { TwoLineRow } from "./limited-list";

export type ActivityEvent = { seq: number; projectKey: string; actorKind: "human" | "agent"; actorName: string; summary: string; createdAt: Date | string };

const when = (d: Date | string) => new Date(d).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

/** One event in two lines: project and what happened, then who and how long ago. Full text and the exact time are in the tooltip. */
export function ActivityRow({ e }: { e: ActivityEvent }) {
  const who = `${e.actorKind === "agent" ? "🤖 " : ""}${e.actorName}`;
  return (
    <TwoLineRow
      href={`/p/${e.projectKey}/activity`}
      lead={e.projectKey}
      title={e.summary}
      meta={`${who} · ${timeAgo(e.createdAt)}`}
      tip={
        <div className="space-y-0.5">
          <div>{e.summary}</div>
          <div className="text-muted">
            {who} · {when(e.createdAt)}
          </div>
        </div>
      }
    />
  );
}
