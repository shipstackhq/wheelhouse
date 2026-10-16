import { useState } from "react";
import { Link } from "react-router";
import clsx from "clsx";
import type { ChecklistItem, ChecklistState } from "@wheelhouse/core/lib/setup-checklist";

const ACTION_LABEL: Record<ChecklistItem["id"], string> = {
  repos: "Connect a repository",
  machines: "Link a machine",
  agents: "Create an API key",
  map: "Build the map",
  teammates: "Invite teammates",
};

/**
 * The project-page setup banner (WH-69). A thin progress bar plus a grid of per-item status cards, each either a
 * settled fact (done) or an action (not done). Collapses to a one-line pill once everything is done — dismissal
 * isn't persisted, since nothing here needs to survive a reload once there is nothing left to do.
 */
export function SetupChecklist({ state }: { state: ChecklistState }) {
  const [expanded, setExpanded] = useState(!state.done);

  if (state.done && !expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="mb-4 flex w-full items-center gap-2 rounded-full border border-ok/30 bg-ok/10 px-4 py-1.5 text-left text-sm text-ok transition-colors hover:bg-ok/15"
      >
        <span aria-hidden>✓</span>
        <span className="font-medium">Setup complete</span>
        <span className="ml-auto text-xs text-ok/70">show details</span>
      </button>
    );
  }

  return (
    <div className="card mb-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Setup</h2>
          <p className="mt-0.5 text-xs text-muted">What&apos;s connected to this project so far.</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs tabular-nums text-muted">
            {state.doneCount}/{state.total}
          </span>
          {state.done && (
            <button type="button" onClick={() => setExpanded(false)} className="text-xs text-muted hover:text-fg">
              Collapse
            </button>
          )}
        </div>
      </div>

      <div className="mt-3 flex gap-1" role="img" aria-label={`${state.doneCount} of ${state.total} setup steps done`}>
        {state.items.map((item) => (
          <div
            key={item.id}
            className={clsx("h-1.5 flex-1 rounded-full transition-colors", item.done ? "bg-ok" : "bg-panel-2")}
          />
        ))}
      </div>

      <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {state.items.map((item) => (
          <li
            key={item.id}
            className={clsx(
              "flex flex-col gap-1 rounded-md border px-3 py-2.5 text-sm",
              item.done ? "border-line bg-panel-2/40" : "border-line",
            )}
          >
            <div className="flex items-center gap-1.5">
              <span className={clsx("flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px]", item.done ? "bg-ok/20 text-ok" : "bg-panel-2 text-muted")} aria-hidden>
                {item.done ? "✓" : "○"}
              </span>
              <span className={clsx("truncate", item.done ? "text-muted" : "font-medium")}>{item.label}</span>
            </div>
            <div className="text-xs leading-snug text-muted">{item.status}</div>
            {!item.done && (
              <Link to={item.href} className="mt-0.5 text-xs font-medium text-accent hover:underline">
                {ACTION_LABEL[item.id]} →
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
