import { timeAgo } from "@wheelhouse/shared/time";
import { TwoLineRow } from "./limited-list";
import { AgentIcon } from "../icons";

export type ActivityEvent = { seq: number; teamKey: string; actorKind: "human" | "agent"; actorName: string; summary: string; createdAt: Date | string };

const when = (d: Date | string) => new Date(d).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

/** One event in two lines: team and what happened, then who and how long ago. Full text and the exact time are in the tooltip. */
export function ActivityRow({ e }: { e: ActivityEvent }) {
  const who = (
    <>
      {e.actorKind === "agent" && <AgentIcon />}
      {e.actorKind === "agent" && " "}
      {e.actorName}
    </>
  );
  return (
    <TwoLineRow
      href={`/t/${e.teamKey}/activity`}
      lead={e.teamKey}
      title={e.summary}
      meta={
        <>
          {who} · {timeAgo(e.createdAt)}
        </>
      }
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
