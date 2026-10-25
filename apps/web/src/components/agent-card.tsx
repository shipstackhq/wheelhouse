import type { ReactNode } from "react";
import type { AgentView } from "@wheelhouse/shared/agents/render";
import { AgentAvatar } from "./agent-avatar";

const KIND = { builder: "Builder", advisor: "Advisor" } as const;
const TOOLS = { edit: "Edits files", "read-only": "Reads only", custom: "Custom tools" } as const;
const MODEL = { inherit: "Default model", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" } as const;

/** An agent in a list: its face, what it is for, and what it can do. `custom` marks one the workspace wrote itself. */
export function AgentCard({ agent, custom = false, action }: { agent: AgentView; custom?: boolean; action?: ReactNode }) {
  return (
    <article className="card flex flex-col gap-2 p-3">
      <div className="flex items-center gap-3">
        <AgentAvatar avatar={agent.avatar} name={agent.name} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col">
          <h3 className="truncate text-sm font-semibold">{agent.name}</h3>
          <span className="truncate text-xs text-muted">{agent.role}</span>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <p className="text-sm text-muted">{agent.summary}</p>
      <ul className="flex flex-wrap gap-1.5 text-xs text-muted">
        <li className="rounded border border-line px-1.5 py-0.5">{KIND[agent.kind]}</li>
        <li className="rounded border border-line px-1.5 py-0.5">{TOOLS[agent.toolProfile]}</li>
        <li className="rounded border border-line px-1.5 py-0.5">{MODEL[agent.model]}</li>
      </ul>
      {custom && <p className="text-xs text-muted">Made by your workspace, not by Wheelhouse: no warranty.</p>}
    </article>
  );
}
