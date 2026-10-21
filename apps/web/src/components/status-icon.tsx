import clsx from "clsx";
import type { StatusColor } from "@wheelhouse/api-client";
import { ICON_COLOR_CLASS } from "./team-icon";

/** The colour of a status's icon when the team has not chosen one: by role. */
export const ROLE_COLOR: Record<string, StatusColor> = {
  backlog: "slate",
  todo: "sky",
  in_progress: "amber",
  review: "violet",
  done: "emerald",
  canceled: "rose",
};

export const statusColor = (role: string, color: StatusColor | null): StatusColor => color ?? ROLE_COLOR[role] ?? "slate";

/**
 * A status's icon, drawn by its role so the stage reads at a glance: a dashed ring (backlog), a ring (todo), a ring filling up (in
 * progress, review), a tick (done) and a cross (canceled), in the status's colour. Decorative: the name is always beside it.
 */
export function StatusIcon({ role, color = null, className }: { role: string; color?: StatusColor | null; className?: string }) {
  const tone = ICON_COLOR_CLASS[statusColor(role, color)].text;
  const ring = <circle cx="7" cy="7" r="5.75" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray={role === "backlog" ? "1.6 1.6" : undefined} />;
  return (
    <svg aria-hidden viewBox="0 0 14 14" className={clsx("size-3.5 shrink-0", tone, className)} data-status-icon={role}>
      {role === "done" || role === "canceled" ? (
        <>
          <circle cx="7" cy="7" r="7" fill="currentColor" />
          {role === "done" ? (
            <path d="M4 7.2l2 2L10 5" fill="none" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          ) : (
            <path d="M4.8 4.8l4.4 4.4M9.2 4.8L4.8 9.2" fill="none" stroke="white" strokeWidth="1.6" strokeLinecap="round" />
          )}
        </>
      ) : (
        <>
          {ring}
          {role === "in_progress" && <path d="M7 3.25a3.75 3.75 0 0 1 0 7.5z" fill="currentColor" />}
          {role === "review" && <path d="M7 7V3.25A3.75 3.75 0 1 1 3.25 7z" fill="currentColor" />}
        </>
      )}
    </svg>
  );
}
