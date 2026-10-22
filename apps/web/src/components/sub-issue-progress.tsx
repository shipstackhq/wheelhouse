import clsx from "clsx";
import type { Progress } from "../lib/sub-issues";

/** A small ring filled by how many sub-issues are done, with "done/total" beside it. Nothing at all for an issue whose sub-issues are all canceled. */
export function SubIssueProgress({ progress, className }: { progress: Progress; className?: string }) {
  if (progress.total === 0) return null;
  const share = progress.done / progress.total;
  const circumference = 2 * Math.PI * 5;
  return (
    <span className={clsx("inline-flex items-center gap-1 text-[11px] tabular-nums text-muted", className)} role="img" aria-label={`${progress.done} of ${progress.total} sub-issues done`} data-sub-progress={`${progress.done}/${progress.total}`}>
      <svg aria-hidden viewBox="0 0 14 14" className={clsx("size-3.5", share === 1 ? "text-ok" : "text-accent")}>
        <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
        <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={`${share * circumference} ${circumference}`} transform="rotate(-90 7 7)" />
      </svg>
      {progress.done}/{progress.total}
    </span>
  );
}
