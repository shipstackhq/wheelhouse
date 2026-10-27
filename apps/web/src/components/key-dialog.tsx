import { useState } from "react";
import { Dialog } from "radix-ui";
import { DEFAULT_KEY_SCOPES, KEY_SCOPES, type KeyScope } from "@wheelhouse/shared/key-scopes";
import type { SetupCommands } from "@wheelhouse/api-client";
import { CopyBlock } from "./copy-block";
import { SecretBox } from "./secret-box";
import { describeFailure } from "../lib/form-state";
import { refreshAll } from "../lib/refresh";
import { useServices } from "../lib/services";
import type { KeyRow, TeamOption } from "./active-keys";

/** What each scope is called and what it lets an agent do. `read` is always on. */
export const SCOPE_INFO: Record<KeyScope, { label: string; hint: string }> = {
  read: { label: "Read", hint: "See issues, cycles, projects, the map and docs" },
  "board:write": { label: "Board", hint: "Create and edit issues, comment" },
  "map:write": { label: "Map", hint: "Update the knowledge map, decisions and glossary" },
  "docs:write": { label: "Docs", hint: "Write docs" },
  "planning:write": { label: "Planning", hint: "Create and edit cycles, projects and milestones" },
};

/** "Read · Board · Map": what a key can do, in plain words. */
export const scopeSummary = (scopes: string[] = []) => KEY_SCOPES.filter((s) => scopes.includes(s)).map((s) => SCOPE_INFO[s].label).join(" · ") || "Nothing";

const overlay = "fixed inset-0 z-40 bg-black/50";
const content = "fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[min(92vw,460px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-line bg-panel p-5 text-fg shadow-2xl";

/**
 * One dialog for a key's settings. New: name, teams and permissions, then (after Create) the secret once and the setup command.
 * Edit (`editing`): the same form, prefilled; it saves teams and scopes. Mount it to open it, unmount on `onClose`.
 */
export function KeyDialog({ teams, setup, editing, onClose }: { teams: TeamOption[]; setup: SetupCommands; editing?: KeyRow; onClose: () => void }) {
  const { api, queryClient } = useServices();
  const [name, setName] = useState(editing?.name ?? "");
  // New keys start with every team ticked; an edited key starts with its own (only the teams the person can give).
  const [picked, setPicked] = useState(() => (editing ? teams.filter((t) => editing.teams?.some((x) => x.key === t.key)) : teams).map((t) => t.key));
  const [scopes, setScopes] = useState<string[]>(editing?.scopes ?? DEFAULT_KEY_SCOPES);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const noTeam = !picked.length;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const chosen = KEY_SCOPES.filter((s) => s === "read" || scopes.includes(s));
    try {
      if (editing) {
        await api.keys.setScopes(editing.id, chosen);
        await api.keys.setTeams(editing.id, picked);
        onClose();
      } else {
        setSecret((await api.keys.create({ name, teams: picked, scopes: chosen })).secret);
      }
    } catch (err) {
      setError(describeFailure(err));
    } finally {
      setBusy(false);
      void refreshAll(queryClient);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className={overlay} />
        <Dialog.Content className={content} aria-describedby={undefined}>
          {secret ? (
            <div className="space-y-3">
              <Dialog.Title className="font-semibold">Key created</Dialog.Title>
              <p className="text-sm text-muted">Copy it now. It won&apos;t be shown again; if you lose it, revoke the key and make another.</p>
              <SecretBox value={secret} />
              <p className="text-sm text-muted">Then connect Claude Code (paste the key when asked):</p>
              <CopyBlock value={setup.mcp} multiline />
              <div className="flex justify-end">
                <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
              </div>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <Dialog.Title className="font-semibold">{editing ? `Edit ${editing.name}` : "New key"}</Dialog.Title>
              {!editing && (
                <label className="block text-sm">
                  <span className="text-xs text-muted">Name</span>
                  <input className="input mt-1" autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder={`e.g. "Claude — Priya's laptop"`} />
                </label>
              )}
              <fieldset className="text-sm">
                <legend className="text-xs text-muted">Teams this agent can open</legend>
                {teams.length === 1 ? (
                  <p className="mt-1">{teams[0].name}</p>
                ) : (
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                    {teams.map((t) => (
                      <label key={t.key} className="flex items-center gap-1.5">
                        <input type="checkbox" checked={picked.includes(t.key)} onChange={() => setPicked((p) => toggle(p, t.key))} />
                        {t.name}
                      </label>
                    ))}
                  </div>
                )}
                {noTeam && <p className="mt-1 text-xs text-warn">Choose at least one team: a key with no team reaches nothing.</p>}
              </fieldset>
              <fieldset className="text-sm">
                <legend className="text-xs text-muted">Permissions</legend>
                <div className="mt-1 space-y-1.5">
                  {KEY_SCOPES.map((s) => (
                    <label key={s} className="flex items-start gap-2">
                      <input type="checkbox" className="mt-1" checked={s === "read" || scopes.includes(s)} disabled={s === "read"} onChange={() => setScopes((p) => toggle(p, s))} />
                      <span>
                        {SCOPE_INFO[s].label}
                        <span className="block text-xs text-muted">{SCOPE_INFO[s].hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              {error && <p className="text-sm text-danger" role="alert">{error}</p>}
              <div className="flex justify-end gap-2">
                <button type="button" className="btn" onClick={onClose}>Cancel</button>
                <button className="btn btn-primary" disabled={noTeam || busy || (!editing && !name.trim())}>{editing ? "Save" : "Create key"}</button>
              </div>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
