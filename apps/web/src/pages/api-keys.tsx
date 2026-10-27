import { useState } from "react";
import { ActiveKeys, splitKeys, type KeyRow } from "../components/active-keys";
import { CopyBlock } from "../components/copy-block";
import { KeyDialog } from "../components/key-dialog";
import { Loaded } from "../components/query-state";
import { RevokedKeys } from "../components/revoked-keys";
import { SetupGuide } from "../components/setup-guide";
import { useApiKeysPage } from "../lib/queries";
import { useTeams } from "../lib/session";
import { refreshAll } from "../lib/refresh";
import { useServices } from "../lib/services";

export function ApiKeysPage() {
  const { api, queryClient } = useServices();
  const query = useApiKeysPage();
  // "new", or the key being edited; null when no dialog is open.
  const [dialog, setDialog] = useState<"new" | KeyRow | null>(null);
  // Teams the person edits are the ones they may give a key (the server refuses the rest).
  const teamOptions = (useTeams().data ?? []).filter((t) => t.role !== "viewer").map((t) => ({ key: t.key, name: t.name }));
  return (
    <Loaded query={query} label="Loading API keys">
      {({ keys, setup: cmd }) => {
        const rows: KeyRow[] = keys.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, lastUsedAt: k.lastUsedAt, revokedAt: k.revokedAt, scopes: k.scopes, teams: k.teams }));
        const { active, revoked } = splitKeys(rows);
        return (
          <div className="h-full overflow-y-auto">
            <div className="w-full space-y-8 px-6 py-10">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h1 className="text-xl font-semibold">API keys</h1>
                  <p className="mt-1 text-sm text-muted">One key per agent (each dev&apos;s Claude Code, a CI bot…): it gets its own change queue, and what it does is attributed to it on the board.</p>
                </div>
                <button type="button" className="btn btn-primary shrink-0" onClick={() => setDialog("new")}>New key</button>
              </div>

              <div>
                <ActiveKeys
                  keys={active}
                  onEdit={setDialog}
                  markAllSeen={async (keyId) => {
                    await api.keys.markAllSeen({ keyId });
                    await refreshAll(queryClient);
                  }}
                  revoke={async (id) => {
                    await api.keys.revoke(id);
                    await refreshAll(queryClient);
                  }}
                />
                <RevokedKeys keys={revoked} />
              </div>

              <details open={!active.length} className="space-y-4">
                <summary className="cursor-pointer text-sm font-medium">Setup guide and other agents</summary>
                <div className="mt-4 space-y-4">
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
              </details>
            </div>
            {dialog && <KeyDialog teams={teamOptions} setup={cmd} editing={dialog === "new" ? undefined : dialog} onClose={() => setDialog(null)} />}
          </div>
        );
      }}
    </Loaded>
  );
}
