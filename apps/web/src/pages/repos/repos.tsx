import { useState, useTransition } from "react";
import clsx from "clsx";
import type { Repository } from "@wheelhouse/api-client";
import { Select, useDialogs } from "../../components/ui";
import { describeFailure } from "../../lib/form-state";
import { refreshAll } from "../../lib/refresh";
import { useServices } from "../../lib/services";

const LIFECYCLES = ["live", "being_replaced", "planned", "retired"] as const;
const PROVIDERS = ["local", "github"] as const;

const lifecycleColor: Record<Repository["lifecycle"], string> = {
  live: "bg-ok/15 text-ok",
  being_replaced: "bg-warn/15 text-warn",
  planned: "bg-accent/15 text-accent",
  retired: "bg-muted/15 text-muted",
};

type Draft = { displayName: string; role: string; provider: Repository["provider"]; defaultBranch: string; pathLimit: string; lifecycle: Repository["lifecycle"] };
const emptyDraft: Draft = { displayName: "", role: "", provider: "local", defaultBranch: "main", pathLimit: "", lifecycle: "live" };

/** The repositories behind a team: add one by hand, change it, retire it. `after` is rendered at the end (the Connect GitHub card). */
export function Repos(props: { teamKey: string; repos: Repository[]; after?: React.ReactNode }) {
  const { api, queryClient } = useServices();
  const [editing, setEditing] = useState<string | null>(null); // repo id, or "new"
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const { confirm, dialogs } = useDialogs();

  const save = (original?: Repository) =>
    start(async () => {
      const patch = {
        displayName: draft.displayName,
        role: draft.role,
        provider: draft.provider,
        defaultBranch: draft.defaultBranch,
        pathLimit: draft.pathLimit || null,
        lifecycle: draft.lifecycle,
      };
      try {
        if (original) await api.repos.update(props.teamKey, original.id, patch);
        else await api.repos.create(props.teamKey, patch);
      } catch (e) {
        return setError(describeFailure(e));
      }
      setEditing(null);
      setError(null);
      await refreshAll(queryClient);
    });

  const form = (original?: Repository) => (
    <div className="space-y-2 rounded-md border border-accent/40 bg-panel p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <input className="input" placeholder="Display name (e.g. Backend)" value={draft.displayName} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} autoFocus />
        <input className="input" placeholder="Role (e.g. backend, frontend, admin)" value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })} />
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <Select value={draft.provider} options={PROVIDERS.map((p) => ({ value: p, label: p }))} onValueChange={(v) => setDraft({ ...draft, provider: v as Repository["provider"] })} />
        <input className="input" placeholder="Default branch" value={draft.defaultBranch} onChange={(e) => setDraft({ ...draft, defaultBranch: e.target.value })} />
        <Select value={draft.lifecycle} options={LIFECYCLES.map((l) => ({ value: l, label: l.replace("_", " ") }))} onValueChange={(v) => setDraft({ ...draft, lifecycle: v as Repository["lifecycle"] })} />
      </div>
      <input
        className="input"
        placeholder="Path limit for monorepos, e.g. packages/billing/ (optional)"
        value={draft.pathLimit}
        onChange={(e) => setDraft({ ...draft, pathLimit: e.target.value })}
      />
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <button className="btn btn-primary" disabled={pending || !draft.displayName.trim() || !draft.role.trim()} onClick={() => save(original)}>
          Save
        </button>
        <button className="btn" onClick={() => (setEditing(null), setError(null))}>
          Cancel
        </button>
      </div>
    </div>
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Repositories</h2>
            <p className="mt-1 text-sm text-muted">
              Frontend, backend, admin… the repos behind this team. A monorepo path limit scopes landed changes and file reports to just that
              directory. Each repository adds a service node to the map.
            </p>
          </div>
          <button className="btn btn-primary shrink-0" onClick={() => (setDraft(emptyDraft), setEditing("new"))}>
            + Add repository
          </button>
        </div>
        <div className="mt-5 space-y-2">
          {editing === "new" && form()}
          {props.repos.length === 0 && editing !== "new" && <p className="py-6 text-center text-sm text-muted">No repositories yet.</p>}
          {props.repos.map((r) =>
            editing === r.id ? (
              <div key={r.id}>{form(r)}</div>
            ) : (
              <div key={r.id} className="group card flex items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{r.displayName}</span>
                    <span className="chip bg-panel-2 text-muted">{r.role}</span>
                    <span className={clsx("chip", lifecycleColor[r.lifecycle])}>{r.lifecycle.replace("_", " ")}</span>
                    <span className="chip bg-panel-2 text-muted">{r.provider}</span>
                  </div>
                  <p className="mt-1 text-sm text-muted">
                    {r.slug} · branch {r.defaultBranch}
                    {r.pathLimit ? ` · limited to ${r.pathLimit}` : ""}
                    {r.lastEventAt ? ` · last activity ${new Date(r.lastEventAt).toLocaleString()}` : " · no activity yet"}
                  </p>
                </div>
                {r.lifecycle !== "retired" && (
                  <div className="flex gap-2 text-xs opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                    <button
                      className="text-muted hover:text-fg"
                      onClick={() =>
                        (setDraft({
                          displayName: r.displayName,
                          role: r.role,
                          provider: r.provider,
                          defaultBranch: r.defaultBranch,
                          pathLimit: r.pathLimit ?? "",
                          lifecycle: r.lifecycle,
                        }),
                        setEditing(r.id))
                      }
                    >
                      Edit
                    </button>
                    <button
                      className="text-muted hover:text-danger"
                      onClick={async () => {
                        if (!(await confirm({ title: `Retire "${r.displayName}"?`, confirmLabel: "Retire", danger: true }))) return;
                        start(async () => {
                          try {
                            await api.repos.retire(props.teamKey, r.id);
                          } catch (e) {
                            setError(describeFailure(e));
                          }
                          await refreshAll(queryClient);
                        });
                      }}
                    >
                      Retire
                    </button>
                  </div>
                )}
              </div>
            ),
          )}
        </div>
        {props.after}
      </div>
      {dialogs}
    </div>
  );
}
