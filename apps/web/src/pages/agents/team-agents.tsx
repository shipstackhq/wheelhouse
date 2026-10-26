import { useState } from "react";
import { useParams } from "react-router";
import { Link } from "../../lib/workspace";
import { Dialog } from "radix-ui";
import { useQuery } from "@tanstack/react-query";
import type { AgentEntry } from "@wheelhouse/api-client";
import { AgentAvatar } from "../../components/agent-avatar";
import { AgentCard } from "../../components/agent-card";
import { CopyBlock } from "../../components/copy-block";
import { Loaded } from "../../components/query-state";
import { useDialogs } from "../../components/ui";
import { describeFailure } from "../../lib/form-state";
import { teamAgentsQuery, useAgents } from "../../lib/queries";
import { refreshAll } from "../../lib/refresh";
import { useServices } from "../../lib/services";
import { useAgentRights } from "../../lib/agent-teams";

/** `/t/:key/agents`: the team's roster. Members read it; workspace admins and the team's admins add and remove. */
export function TeamAgentsPage() {
  const { key = "" } = useParams();
  const { api } = useServices();
  const roster = useQuery(teamAgentsQuery(api, key));
  const all = useAgents();
  const { teams } = useAgentRights();
  return (
    <Loaded query={roster} label="Loading the agents">
      {(agents) => <Roster teamKey={key} agents={agents} enabled={all.data?.enabled ?? true} manage={teams.some((t) => t.key === key)} />}
    </Loaded>
  );
}

function Roster({ teamKey, agents, enabled, manage }: { teamKey: string; agents: AgentEntry[]; enabled: boolean; manage: boolean }) {
  const { api, queryClient } = useServices();
  const { confirm, dialogs } = useDialogs();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();
  const attempt = async (run: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await run();
    } catch (e) {
      setError(describeFailure(e));
    }
    await refreshAll(queryClient);
  };
  const remove = async (a: AgentEntry) => {
    if (await confirm({ title: `Remove ${a.name}?`, description: "It leaves this team's roster. The agent itself is kept.", confirmLabel: "Remove" })) await attempt(() => api.teams.removeAgent(teamKey, a.slug));
  };
  return (
    <div className="h-full overflow-y-auto">
      <div className="w-full space-y-6 px-6 py-10">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Agents</h1>
            <p className="mt-1 text-sm text-muted">The agents this team uses in Claude Code.</p>
          </div>
          {enabled && manage && <button className="btn btn-primary shrink-0" onClick={() => setAdding(true)}>Add</button>}
        </div>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {!enabled ? (
          <p className="card p-5 text-sm text-muted">Agents are off for this workspace.</p>
        ) : agents.length === 0 ? (
          <p className="text-sm text-muted">No agents on this team yet.{manage && " Use Add to pick some."}</p>
        ) : (
          <>
            <div className="flex flex-col gap-3">
              {agents.map((a) => (
                <AgentCard
                  key={a.slug}
                  agent={a}
                  custom={a.source === "custom"}
                  action={
                    <div className="flex gap-2">
                      <Link to={`/agents/${a.slug}`} className="btn" aria-label={`Open ${a.name}`}>Open</Link>
                      {manage && <button className="btn" aria-label={`Remove ${a.name}`} onClick={() => void remove(a)}>Remove</button>}
                    </div>
                  }
                />
              ))}
            </div>
            <div className="card space-y-2 p-5">
              <h2 className="font-medium">Use in Claude Code</h2>
              <p className="text-sm text-muted">In a repository linked to this team, run this once (it also runs when a session starts), then ask for an agent by name.</p>
              <CopyBlock value="/wheelhouse:agents" />
              <p className="text-sm text-muted">Then, for example: <code className="font-mono">use wh-{agents[0].slug} to …</code></p>
            </div>
          </>
        )}
      </div>
      {dialogs}
      {adding && <AddDialog teamKey={teamKey} onRoster={agents.map((a) => a.slug)} onClose={() => setAdding(false)} add={(slug) => attempt(() => api.teams.addAgent(teamKey, slug))} />}
    </div>
  );
}

/** The catalog and the workspace's agents that are not on the roster yet (a team agent only on its own team). */
function AddDialog({ teamKey, onRoster, onClose, add }: { teamKey: string; onRoster: string[]; onClose: () => void; add: (slug: string) => Promise<void> }) {
  const data = useAgents().data;
  const options = [...(data?.catalog ?? []), ...(data?.workspace ?? [])].filter((a) => !onRoster.includes(a.slug) && (a.source === "catalog" || !a.teamKey || a.teamKey === teamKey));
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[min(92vw,520px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-line bg-panel p-5 text-fg shadow-2xl">
          <Dialog.Title className="font-semibold">Add agents</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-muted">Wheelhouse&apos;s agents and your workspace&apos;s.</Dialog.Description>
          <ul className="mt-3 divide-y divide-line text-sm">
            {options.map((a) => (
              <li key={a.slug} className="flex items-center gap-3 py-2">
                <AgentAvatar avatar={a.avatar} name={a.name} size="md" />
                <span className="flex min-w-0 flex-1 flex-col"><span className="font-medium">{a.name}</span><span className="text-xs text-muted">{a.role}</span></span>
                <button className="btn" aria-label={`Add ${a.name}`} onClick={() => void add(a.slug)}>Add</button>
              </li>
            ))}
            {options.length === 0 && <li className="py-2 text-muted">Everything is already on this team.</li>}
          </ul>
          <div className="mt-4 flex justify-end">
            <Dialog.Close className="btn">Done</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
