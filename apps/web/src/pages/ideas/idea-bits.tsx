import clsx from "clsx";
import type { IdeaStatus } from "@wheelhouse/api-client";

export const IDEA_STATUSES: IdeaStatus[] = ["new", "exploring", "promoted", "parked"];
/** What a person can set by hand: `promoted` is only reached with the Promote action. */
export const SETTABLE_STATUSES = IDEA_STATUSES.filter((s) => s !== "promoted");

const STATUS_STYLE: Record<IdeaStatus, string> = {
  new: "bg-accent/15 text-accent",
  exploring: "bg-warn/15 text-warn",
  promoted: "bg-ok/15 text-ok",
  parked: "bg-panel-2 text-muted",
};
export const ideaStatusChip = (s: IdeaStatus) => <span className={clsx("chip", STATUS_STYLE[s])}>{s}</span>;

/** Where an issue opens: its team's board with the issue's dialog on top. A ref is `KEY-number`. */
export const issueHref = (ref: string) => `/t/${ref.slice(0, ref.lastIndexOf("-"))}?t=${encodeURIComponent(ref)}`;

export const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
