import { useState } from "react";
import { useParams } from "react-router";
import { Link } from "../../lib/workspace";
import { useQuery } from "@tanstack/react-query";
import { CATALOG } from "@wheelhouse/shared/agents/catalog/index";
import type { AgentEntry, AgentProfile, AgentsPage as AgentsData, CatalogAgent, CustomAgent } from "@wheelhouse/api-client";
import { AgentAvatar } from "../../components/agent-avatar";
import { Page } from "../../components/page";
import { AvatarEditor } from "../../components/avatar-editor";
import { Loaded } from "../../components/query-state";
import { Select } from "../../components/ui";
import { describeFailure } from "../../lib/form-state";
import { agentVersionsQuery, guardrailsQuery, useAgents } from "../../lib/queries";
import { refreshAll } from "../../lib/refresh";
import { useServices } from "../../lib/services";
import { useAgentRights } from "../../lib/agent-teams";
import { NotFound } from "../../routes/errors";
import { AgentForm } from "./agent-form";

const Wrap = ({ children }: { children: React.ReactNode }) => (
  <div className="h-full overflow-y-auto">
    <div className="w-full space-y-6 px-6 py-10">{children}</div>
  </div>
);

/** `/agents`: Wheelhouse's catalog and the workspace's own agents (docs/agents-plan.md). */
export function AgentsPage() {
  const query = useAgents();
  return (
    <Loaded query={query} label="Loading agents">
      {(data) => <Agents data={data} />}
    </Loaded>
  );
}

function Agents({ data }: { data: AgentsData }) {
  const { admin, canCreate } = useAgentRights();
  const [creating, setCreating] = useState(false);
  const list = (agents: AgentEntry[]) => (
    <ul className="card divide-y divide-line">
      {agents.map((a) => (
        <li key={a.slug} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
          <AgentAvatar avatar={a.avatar} name={a.name} size="md" />
          <div className="min-w-40 flex-1">
            <div className="font-medium">{a.name}{a.source === "custom" && <span className="text-muted"> (custom)</span>}</div>
            <div className="text-xs text-muted">{a.role} · {a.summary}</div>
          </div>
          <Link to={`/agents/${a.slug}`} className="btn" aria-label={`Open ${a.name}`}>Open</Link>
        </li>
      ))}
    </ul>
  );
  return (
    <Page
      title="Agents"
      hint="Agents with a role and rules, ready to use in Claude Code. Add them to a team to use them there."
      action={data.enabled && canCreate && <button className="btn btn-primary shrink-0" onClick={() => setCreating(true)}>New agent</button>}
      className="space-y-6"
    >
      {!data.enabled ? (
        <div className="card p-5 text-sm">
          <p className="font-medium">Agents are off for this workspace.</p>
          {admin ? (
            <p className="mt-1 text-muted">Turn them on in <Link to="/settings/workspace" className="underline">workspace settings</Link>. Nothing is lost while they are off.</p>
          ) : (
            <p className="mt-1 text-muted">A workspace admin can turn them on in the workspace settings.</p>
          )}
        </div>
      ) : (
        <>
          <section className="space-y-3">
            <h2 className="font-medium">Wheelhouse agents</h2>
            {list(data.catalog)}
          </section>
          <section className="space-y-3">
            <h2 className="font-medium">Your workspace&apos;s agents</h2>
            {data.workspace.length ? list(data.workspace) : <p className="text-sm text-muted">None yet.{canCreate && " Use New agent to write one."}</p>}
          </section>
          {creating && <AgentForm open onOpenChange={setCreating} />}
        </>
      )}
    </Page>
  );
}

/** `/agents/:slug`: one agent's whole profile, the guardrails, and what the person may do with it. */
export function AgentPage() {
  const { slug = "" } = useParams();
  const query = useAgents();
  return (
    <Loaded query={query} label="Loading the agent">
      {(data) => {
        const agent: AgentEntry | undefined = data.enabled ? [...data.catalog, ...data.workspace].find((a) => a.slug === slug) : undefined;
        return agent ? <Agent agent={agent} /> : <NotFound />;
      }}
    </Loaded>
  );
}

function Agent({ agent }: { agent: AgentEntry }) {
  const profile = agent.source === "custom" ? agent.profile : CATALOG[agent.slug][agent.version - 1];
  return (
    <Wrap>
      <div className="flex gap-4">
        <AgentAvatar avatar={agent.avatar} name={agent.name} size="xl" />
        <div className="min-w-0 flex-1">
          <Link to="/agents" className="text-xs text-muted hover:text-fg">Agents</Link>
          <h1 className="text-xl font-semibold">{agent.name} <span className="text-sm font-normal text-muted">{agent.role}</span></h1>
          <p className="text-sm text-muted">{agent.summary}</p>
          {agent.source === "custom" && <p className="mt-1 text-xs text-muted">Made by your workspace, not by Wheelhouse: no warranty.</p>}
        </div>
      </div>
      <AddToTeam agent={agent} />
      {agent.source === "catalog" ? <CatalogVersion agent={agent} /> : <CustomActions agent={agent} />}
      <Profile profile={profile} />
      <Guardrails />
    </Wrap>
  );
}

const items = (list: string[]) => (
  <ul className="list-disc space-y-0.5 pl-5">
    {list.map((l) => <li key={l}>{l}</li>)}
  </ul>
);

function Profile({ profile: p }: { profile: AgentProfile }) {
  const row = (label: string, body: React.ReactNode) => (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0">{body}</dd>
    </>
  );
  return (
    <div className="card p-5">
      <h2 className="font-medium">Profile</h2>
      <dl className="mt-3 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[140px_1fr]">
        {row("Use it when", p.description)}
        {row("Kind", p.kind)}
        {row("Tools", p.toolProfile === "custom" ? `custom: ${(p.tools ?? []).join(", ")}` : p.toolProfile)}
        {row("Model", p.model)}
        {row("Works in", p.pathScope.length ? p.pathScope.join(", ") : "the whole repository")}
        {row("Instructions", <p className="whitespace-pre-wrap">{p.instructions}</p>)}
        {p.rules.length > 0 &&
          row("Rules", (
            <ul className="list-disc space-y-1 pl-5">
              {p.rules.map((r) => (
                <li key={r.rule}>
                  {r.rule}
                  {r.why && <span className="text-muted"> Why: {r.why}</span>}
                  {r.example && <span className="text-muted"> Example: {r.example}</span>}
                </li>
              ))}
            </ul>
          ))}
        {p.done.length > 0 && row("Done means", items(p.done))}
        {p.askWhen.length > 0 && row("Asks when", items(p.askWhen))}
      </dl>
    </div>
  );
}

/** The Wheelhouse guardrails every agent is rendered with: anyone may read them, nobody here changes them. */
function Guardrails() {
  const { api } = useServices();
  const { data } = useQuery(guardrailsQuery(api));
  return (
    <details className="card p-5">
      <summary className="cursor-pointer font-medium">Wheelhouse guardrails{data && ` (v${data.version})`}</summary>
      <p className="mt-2 text-xs text-muted">Added before every agent&apos;s own text, and they win over it. Read only.</p>
      {data && <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-md border border-line bg-bg p-3 font-mono text-[12px]">{data.text}</pre>}
    </details>
  );
}

/** Add this agent to a team the person may change the roster of (a team agent only to its own team). */
function AddToTeam({ agent }: { agent: AgentEntry }) {
  const { api, queryClient } = useServices();
  const { teams } = useAgentRights();
  const options = teams.filter((t) => agent.source === "catalog" || !agent.teamKey || agent.teamKey === t.key);
  const [key, setKey] = useState("");
  const [note, setNote] = useState<{ error?: string; ok?: string }>();
  if (!options.length) return null;
  const chosen = key || options[0].key;
  const add = async () => {
    try {
      await api.teams.addAgent(chosen, agent.slug);
      await refreshAll(queryClient);
      setNote({ ok: `Added to ${options.find((t) => t.key === chosen)!.name}.` });
    } catch (e) {
      setNote({ error: describeFailure(e) });
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select ariaLabel="Team" options={options.map((t) => ({ value: t.key, label: t.name }))} value={chosen} onValueChange={setKey} className="w-48" />
      <button className="btn btn-primary" onClick={() => void add()}>Add to team</button>
      {note?.ok && <span role="status" className="text-sm text-muted">{note.ok}</span>}
      {note?.error && <span role="alert" className="text-sm text-danger">{note.error}</span>}
    </div>
  );
}

/** The catalog version in use; workspace admins pin it or follow the latest. */
function CatalogVersion({ agent }: { agent: CatalogAgent }) {
  const { api, queryClient } = useServices();
  const { admin } = useAgentRights();
  const [error, setError] = useState<string>();
  const behind = agent.pinnedVersion !== null && agent.latestVersion > agent.pinnedVersion;
  const versions = useQuery({ ...agentVersionsQuery(api, agent.slug), enabled: behind });
  const note = versions.data?.[0];
  const pin = async (version: number | null) => {
    setError(undefined);
    try {
      await api.agents.pin(agent.slug, version);
      await refreshAll(queryClient);
    } catch (e) {
      setError(describeFailure(e));
    }
  };
  return (
    <div className="card flex flex-wrap items-center gap-3 p-5 text-sm">
      <div className="min-w-0 flex-1">
        <p className="font-medium">Version {agent.version} in use <span className="font-normal text-muted">{agent.pinnedVersion === null ? "(following the latest)" : "(pinned)"}</span></p>
        {behind && <p className="mt-1 text-muted">Version {agent.latestVersion} is available{note?.changelog ? `: ${note.changelog}` : "."}</p>}
        {error && <p role="alert" className="mt-1 text-danger">{error}</p>}
      </div>
      {admin && (agent.pinnedVersion === null ? <button className="btn" onClick={() => void pin(agent.version)}>Pin version {agent.version}</button> : <button className="btn" onClick={() => void pin(null)}>Follow latest</button>)}
    </div>
  );
}

/** Change face and Edit, for those the server says may. */
function CustomActions({ agent }: { agent: CustomAgent }) {
  const { api, queryClient } = useServices();
  const [dialog, setDialog] = useState<"face" | "edit" | null>(null);
  if (!agent.can?.face && !agent.can?.edit) return null;
  return (
    <div className="flex gap-2">
      {agent.can.face && <button className="btn" onClick={() => setDialog("face")}>Change face</button>}
      {agent.can.edit && <button className="btn" onClick={() => setDialog("edit")}>Edit</button>}
      {dialog === "face" && (
        <AvatarEditor
          open
          onOpenChange={(o) => !o && setDialog(null)}
          agent={agent}
          onSave={async (patch) => {
            await api.agents.update(agent.slug, patch);
            await refreshAll(queryClient);
          }}
        />
      )}
      {dialog === "edit" && <AgentForm open onOpenChange={(o) => !o && setDialog(null)} agent={agent.profile} />}
    </div>
  );
}
