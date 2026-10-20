import { useActionState, useState } from "react";
import { ActiveKeys, splitKeys, type KeyRow } from "../components/active-keys";
import { CopyBlock } from "../components/copy-block";
import { Loaded } from "../components/query-state";
import { RevokedKeys } from "../components/revoked-keys";
import { SecretBox } from "../components/secret-box";
import { SetupGuide } from "../components/setup-guide";
import { SubmitButton } from "../components/submit-button";
import { failure, field, type FormState } from "../lib/form-state";
import { useAgentsPage } from "../lib/queries";
import { useTeams } from "../lib/session";
import { refreshAll } from "../lib/refresh";
import { useServices } from "../lib/services";

export function AgentsPage() {
  const { api, queryClient } = useServices();
  const query = useAgentsPage();
  // Teams the person edits are the ones they may give a key (the server refuses the rest).
  const teamOptions = (useTeams().data ?? []).filter((t) => t.role !== "viewer").map((t) => ({ key: t.key, name: t.name }));
  return (
    <Loaded query={query} label="Loading agents">
      {({ keys, setup: cmd }) => {
        const rows: KeyRow[] = keys.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, lastUsedAt: k.lastUsedAt, revokedAt: k.revokedAt, canWriteDocs: k.canWriteDocs, teams: k.teams }));
        const { active, revoked } = splitKeys(rows);
        return (
          <div className="h-full overflow-y-auto">
            <div className="mx-auto max-w-3xl space-y-8 px-6 py-10">
              <div>
                <h1 className="text-xl font-semibold">Agents &amp; API keys</h1>
                <p className="mt-1 text-sm text-muted">
                  Give each agent (each dev&apos;s Claude Code, a CI bot…) its own key. Every key gets its own change queue, and everything it does is
                  attributed to it on the board.
                </p>
              </div>

              <div className="card p-5">
                <h2 className="font-medium">1. Create a key</h2>
                <p className="text-sm text-muted">The key is shown once, right after you create it. Copy it then; if you lose it, revoke it and create another.</p>
                <CreateKeyForm teams={teamOptions} />
                <ActiveKeys
                  keys={active}
                  markAllSeen={async (fd) => {
                    await api.agents.markAllSeen({ keyId: field(fd, "keyId") });
                    await refreshAll(queryClient);
                  }}
                  revoke={async (fd) => {
                    await api.keys.revoke(field(fd, "id"));
                    await refreshAll(queryClient);
                  }}
                  teamOptions={teamOptions}
                  setTeams={async (keyId, teams) => {
                    try {
                      await api.keys.setTeams(keyId, teams);
                    } finally {
                      await refreshAll(queryClient);
                    }
                  }}
                  setDocsWrite={async (keyId, canWrite) => {
                    try {
                      await api.keys.setDocsWrite(keyId, canWrite);
                    } finally {
                      await refreshAll(queryClient);
                    }
                  }}
                />
                <RevokedKeys keys={revoked} />
              </div>

              <SetupGuide cmd={cmd} />

              <div className="card space-y-3 p-5">
                <h2 className="font-medium">Other agents and CI</h2>
                <p className="text-sm text-muted">
                  Any MCP client can connect to <code className="font-mono">{cmd.url}/mcp</code> with an <code className="font-mono">Authorization: Bearer</code>{" "}
                  header (the Claude Code command is in setup B). The same operations are available over HTTP for scripts and CI (list them at{" "}
                  <code className="font-mono">GET {cmd.url}/api/v1</code>). In CI, keep the key in the provider&apos;s secret store and expose it as{" "}
                  <code className="font-mono">WHEELHOUSE_KEY</code>.
                </p>
                <CopyBlock value={cmd.rest} multiline />
              </div>
            </div>
          </div>
        );
      }}
    </Loaded>
  );
}

function CreateKeyForm({ teams }: { teams: { key: string; name: string }[] }) {
  const { api, queryClient } = useServices();
  // Every team the person edits starts ticked; an agent reaches only the teams ticked here.
  const [unticked, setUnticked] = useState<string[]>([]);
  const chosen = teams.filter((t) => !unticked.includes(t.key)).map((t) => t.key);
  const [state, action] = useActionState<FormState, FormData>(async (_prev, fd) => {
    try {
      if (teams.length && !chosen.length) return { error: "Choose at least one team: a key with no team reaches nothing." };
      const { key, secret } = await api.keys.create(field(fd, "name"), teams.length ? chosen : undefined);
      void refreshAll(queryClient);
      return { ok: `Key "${key.name}" created. Copy it now — it won't be shown again.`, secret };
    } catch (e) {
      return failure(e);
    }
  }, undefined);
  return (
    <form action={action} className="mt-3 space-y-2">
      <div className="flex gap-2">
        <input className="input" name="name" aria-label="Key name" placeholder={`e.g. "Claude — Priya's laptop"`} />
        <SubmitButton className="btn btn-primary shrink-0">Create key</SubmitButton>
      </div>
      {teams.length > 0 && (
        <fieldset className="text-sm">
          <legend className="text-xs text-muted">Teams this agent can open</legend>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {teams.map((t) => (
              <label key={t.key} className="flex items-center gap-1.5">
                <input type="checkbox" checked={!unticked.includes(t.key)} onChange={() => setUnticked((u) => (u.includes(t.key) ? u.filter((k) => k !== t.key) : [...u, t.key]))} />
                {t.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {state?.error && <p className="text-sm text-danger" role="alert">{state.error}</p>}
      {state?.ok && <p className="text-sm text-ok">{state.ok}</p>}
      {state?.secret && <SecretBox value={state.secret} />}
    </form>
  );
}
