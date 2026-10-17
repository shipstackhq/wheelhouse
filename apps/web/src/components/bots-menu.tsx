import { Link } from "react-router";
import { Popover } from "radix-ui";
import clsx from "clsx";
import { field } from "../lib/form-state";
import { refreshAll } from "../lib/refresh";
import { useServices } from "../lib/services";
import { BotsList, type Bot } from "./bots-list";
import { SessionRemoveButton } from "./session-remove-button";
import { AgentIcon, ArrowRightIcon } from "./icons";

export type { Bot } from "./bots-list";

/** Header button: summary dot + count, popover with every agent and its sync status for this project. */
export function BotsMenu({ projectKey, bots }: { projectKey: string; bots: Bot[] }) {
  const { api, queryClient } = useServices();
  const queued = bots.filter((b) => b.pending > 0);
  const total = queued.reduce((n, b) => n + b.pending, 0);
  const state = bots.length === 0 ? "none" : queued.length ? "queued" : "synced";

  return (
    <Popover.Root>
      <Popover.Trigger
        className="btn gap-2 py-1 text-xs data-[state=open]:border-muted/60 data-[state=open]:bg-panel-2"
        aria-label={`Bots: ${state === "none" ? "none connected" : state === "queued" ? `${total} queued change(s)` : "all in sync"}`}
      >
        <span
          className={clsx("h-2 w-2 rounded-full", state === "queued" ? "bg-agent" : state === "synced" ? "bg-ok" : "bg-muted/50")}
          aria-hidden
        />
        <AgentIcon /> Bots
        <span className={clsx("tabular-nums", state === "queued" ? "text-agent" : "text-muted")}>
          {state === "none" ? "0" : state === "queued" ? `${total} queued` : bots.length}
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          collisionPadding={8}
          className="z-50 w-80 max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg border border-line bg-panel text-fg shadow-xl"
        >
          <div className="border-b border-line px-4 py-3">
            <div className="text-sm font-medium">Bots in {projectKey}</div>
            <div className="text-xs text-muted">
              {state === "none" ? "No agents connected yet." : state === "queued" ? `${queued.length} of ${bots.length} behind` : "All caught up"}
            </div>
          </div>
          {bots.length > 0 && (
            <BotsList
              projectKey={projectKey}
              bots={bots}
              markAllSeen={async (fd) => {
                await api.agents.markAllSeen({ keyId: field(fd, "keyId"), projectKey: field(fd, "project") || projectKey });
                await refreshAll(queryClient);
              }}
              sessionAction={(x) => <SessionRemoveButton projectKey={x.projectKey ?? projectKey} sessionId={x.id} />}
            />
          )}
          <div className="border-t border-line px-4 py-2.5 text-xs">
            <Link to="/agents" className="text-muted hover:text-fg">
              {bots.length ? "Manage agents & API keys" : "Create an API key"} <ArrowRightIcon />
            </Link>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
