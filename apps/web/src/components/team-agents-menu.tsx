import { Popover } from "radix-ui";
import { useQuery } from "@tanstack/react-query";
import type { BoardIssue, DelegationState, RosterAgent } from "@wheelhouse/api-client";
import { Link } from "../lib/workspace";
import { boardQuery, teamAgentsQuery } from "../lib/queries";
import { useServices } from "../lib/services";
import { AgentAvatar } from "./agent-avatar";
import { issueHref } from "../pages/ideas/idea-bits";

const ACTIVE: DelegationState[] = ["waiting", "running", "asked"];

/** Each roster agent with the issues delegated to it that are still in flight. Pure, for tests. */
export function agentWork(agents: RosterAgent[], issues: BoardIssue[]) {
  return agents.map((agent) => ({ agent, issues: issues.filter((i) => i.delegateAgentId === agent.id && i.delegation && ACTIVE.includes(i.delegation.state)) }));
}

/** Header: the team's agents at a glance (busy ones as an avatar stack), and a popover of who is working on what. */
export function TeamAgentsMenu({ teamKey }: { teamKey: string }) {
  const { api } = useServices();
  const agents = useQuery(teamAgentsQuery(api, teamKey)).data;
  const board = useQuery(boardQuery(api, teamKey)).data;
  if (!agents?.length || !board) return null;
  const work = agentWork(agents, board.issues);
  const busy = work.filter((w) => w.issues.length);

  return (
    <Popover.Root>
      <Popover.Trigger className="btn btn-ghost h-8 gap-1.5 px-2 text-xs data-[state=open]:bg-panel-2" aria-label={`Agents: ${busy.length} working`}>
        <span className="flex -space-x-1.5">
          {(busy.length ? busy : work).slice(0, 3).map((w) => <AgentAvatar key={w.agent.id} avatar={w.agent.avatar} name={w.agent.name} size="sm" />)}
        </span>
        <span className="text-muted">{busy.length ? `${busy.length} working` : "Idle"}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={8} collisionPadding={8} className="z-50 w-80 max-w-[calc(100vw-1rem)] rounded-lg border border-line bg-panel text-fg shadow-xl">
          <div className="border-b border-line px-4 py-3 text-sm font-medium">Agents in {teamKey}</div>
          <ul className="max-h-96 divide-y divide-line overflow-y-auto">
            {work.map(({ agent, issues }) => (
              <li key={agent.id} className="flex gap-3 px-4 py-2.5">
                <AgentAvatar avatar={agent.avatar} name={agent.name} size="md" />
                <div className="min-w-0 flex-1 text-sm">
                  <div className="font-medium">{agent.name}</div>
                  {issues.length === 0 && <div className="text-xs text-muted">Idle</div>}
                  {issues.map((i) => (
                    <Link key={i.id} to={issueHref(i.ref)} className="block truncate text-xs text-muted hover:text-fg" title={i.delegation?.line ?? i.title}>
                      <span className="text-fg">{i.ref}</span> {i.title} · {i.delegation?.state}
                    </Link>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
