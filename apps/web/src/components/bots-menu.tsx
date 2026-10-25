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

/** Header button: summary dot + count, popover with every agent and its sync status for this team. */
export function BotsMenu({ teamKey, bots }: { teamKey: string; bots: Bot[] }) {
  const { api, queryClient } = useServices();
  const queued = bots.filter((b) => b.pending > 0);
  const total = queued.reduce((n, b) => n + b.pending, 0);
  const state = bots.length === 0 ? "none" : queued.length ? "queued" : "synced";

  return (
    <Popover.Root>
      <Popover.Trigger
        className="btn btn-ghost relative h-8 w-8 shrink-0 !rounded-full p-0 text-base data-[state=open]:bg-panel-2 data-[state=open]:text-fg"
        aria-label={`Bots: ${state === "none" ? "none connected" : state === "queued" ? `${total} queued change(s)` : "all in sync"}`}
        title={state === "none" ? "No bots connected" : state === "queued" ? `${total} queued` : `${bots.length} in sync`}
      >
        <AgentIcon />
        <span
          className={clsx("absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full", state === "queued" ? "bg-agent" : state === "synced" ? "bg-ok" : "bg-muted/50")}
          aria-hidden
        />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          collisionPadding={8}
          className="z-50 w-80 max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg border border-line bg-panel text-fg shadow-xl"
        >
          <div className="border-b border-line px-4 py-3">
            <div className="text-sm font-medium">Bots in {teamKey}</div>
            <div className="text-xs text-muted">
              {state === "none" ? "No agents connected yet." : state === "queued" ? `${queued.length} of ${bots.length} behind` : "All caught up"}
            </div>
          </div>
          {bots.length > 0 && (
            <BotsList
              teamKey={teamKey}
              bots={bots}
              markAllSeen={async (fd) => {
                await api.keys.markAllSeen({ keyId: field(fd, "keyId"), teamKey: field(fd, "team") || teamKey });
                await refreshAll(queryClient);
              }}
              sessionAction={(x) => <SessionRemoveButton teamKey={x.teamKey ?? teamKey} sessionId={x.id} />}
            />
          )}
          <div className="border-t border-line px-4 py-2.5 text-xs">
            <Link to="/api-keys" className="text-muted hover:text-fg">
              {bots.length ? "Manage API keys" : "Create an API key"} <ArrowRightIcon />
            </Link>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
