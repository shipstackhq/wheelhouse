import { useState } from "react";
import { KEY_SCOPES } from "@wheelhouse/shared/key-scopes";
import { timeAgo } from "@wheelhouse/shared/time";
import { List } from "./list";
import { SubmitButton } from "./submit-button";
import { AgentIcon } from "./icons";

/** What the keys lists need. Dates are ISO strings so the revoked list can cross into a client component. */
export type KeyRow = { id: string; name: string; prefix: string; lastUsedAt: string | null; revokedAt: string | null; scopes?: string[]; teams?: { key: string; name: string }[] };
/** A team a key could be given: one the person edits. */
export type TeamOption = { key: string; name: string };

/** Live keys keep the order they came in; revoked ones go most recently revoked first. */
export function splitKeys(keys: KeyRow[]) {
  const active = keys.filter((k) => !k.revokedAt);
  const revoked = keys.filter((k) => k.revokedAt).sort((a, b) => b.revokedAt!.localeCompare(a.revokedAt!));
  return { active, revoked };
}

/**
 * The keys that work today: name, prefix, when last used, and the two things you can do to one. The actions are passed in
 * so the component stays presentational (and renderable in tests without a server).
 */
export function ActiveKeys({
  keys,
  markAllSeen,
  revoke,
  setScopes,
  teamOptions,
  setTeams,
}: {
  keys: KeyRow[];
  markAllSeen: (formData: FormData) => void | Promise<void>;
  revoke: (formData: FormData) => void | Promise<void>;
  /** Set the scopes a key holds (WH-51). A new key reads and writes the board and the map; docs and planning are off. */
  setScopes?: (keyId: string, scopes: string[]) => void | Promise<void>;
  /** WH-120: the teams the person may give a key, and how to save a key's teams. Without them the teams are only shown. */
  teamOptions?: TeamOption[];
  setTeams?: (keyId: string, teams: string[]) => void | Promise<void>;
}) {
  if (!keys.length) return <p className="mt-5 text-sm text-muted">No active keys. Create one above.</p>;
  return (
    <List inset="card" className="mt-5 text-sm">
      {keys.map((k) => (
        <li key={k.id} className="flex items-center gap-3">
          <span className="text-agent"><AgentIcon /> {k.name}</span>
          <code className="font-mono text-xs text-muted">{k.prefix}…</code>
          {setScopes &&
            KEY_SCOPES.map((scope) => (
              <label key={scope} className="ml-3 flex items-center gap-1.5 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={!!k.scopes?.includes(scope)}
                  onChange={(e) => void setScopes(k.id, e.target.checked ? [...(k.scopes ?? []), scope] : (k.scopes ?? []).filter((s) => s !== scope))}
                />
                {scope}
              </label>
            ))}
          {k.teams && <KeyTeams k={k} options={teamOptions ?? []} save={setTeams} />}
          <span className="ml-auto text-xs text-muted">{k.lastUsedAt ? `used ${timeAgo(k.lastUsedAt)}` : "never used"}</span>
          <form action={markAllSeen}>
            <input type="hidden" name="keyId" value={k.id} />
            <SubmitButton className="btn btn-ghost py-1 text-xs" title="Reset this agent's queue in every team">Mark all seen</SubmitButton>
          </form>
          <form action={revoke}>
            <input type="hidden" name="id" value={k.id} />
            <SubmitButton className="btn btn-danger py-1 text-xs">Revoke</SubmitButton>
          </form>
        </li>
      ))}
    </List>
  );
}

/** The teams a key can open: chips, and (when the person can change them) a small editor. A key with none reaches nothing, and says so. */
function KeyTeams({ k, options, save }: { k: KeyRow; options: TeamOption[]; save?: (keyId: string, teams: string[]) => void | Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const teams = k.teams ?? [];
  if (editing && save) {
    // Teams of the key the person cannot edit are not theirs to give or take: they stay as they are and are not offered.
    const toggle = (key: string) => setPicked((p) => (p.includes(key) ? p.filter((x) => x !== key) : [...p, key]));
    return (
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" role="group" aria-label={`Teams of ${k.name}`}>
        {options.map((t) => (
          <label key={t.key} className="flex items-center gap-1">
            <input type="checkbox" checked={picked.includes(t.key)} onChange={() => toggle(t.key)} />
            {t.name}
          </label>
        ))}
        <button
          type="button"
          className="btn btn-primary py-0.5 text-xs"
          disabled={!picked.length}
          onClick={async () => {
            try {
              await save(k.id, picked);
              setEditing(false);
              setError(null);
            } catch (e) {
              setError(e instanceof Error ? e.message : "Could not save the teams");
            }
          }}
        >
          Save teams
        </button>
        <button type="button" className="btn btn-ghost py-0.5 text-xs" onClick={() => (setEditing(false), setError(null))}>
          Cancel
        </button>
        {error && <span className="text-danger" role="alert">{error}</span>}
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-1 text-xs">
      {teams.length === 0 ? <span className="text-warn">no teams: reaches nothing</span> : teams.map((t) => <span key={t.key} className="chip bg-panel-2 text-muted" title={t.name}>{t.key}</span>)}
      {save && (
        <button type="button" className="text-muted hover:text-fg" aria-label={`Change the teams of ${k.name}`} onClick={() => (setPicked(teams.map((t) => t.key).filter((key) => options.some((o) => o.key === key))), setEditing(true))}>
          Teams
        </button>
      )}
    </span>
  );
}
