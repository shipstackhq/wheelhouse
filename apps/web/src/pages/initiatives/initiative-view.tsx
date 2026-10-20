import { useState, useTransition } from "react";
import { Link, useNavigate } from "react-router";
import type { InitiativeDetail, ProjectHealthValue } from "@wheelhouse/api-client";
import { Select, useDialogs } from "../../components/ui";
import { describeFailure } from "../../lib/form-state";
import { refreshAll } from "../../lib/refresh";
import { useServices } from "../../lib/services";
import { Progress } from "../cycles/cycle-bits";
import { HEALTHS, healthLabel, HealthChip, statusChip as projectStatusChip } from "../projects/project-bits";
import { draftOf, initiativeStatusChip, InitiativeForm, inputOf, targetOf, type InitiativeDraft } from "./initiative-bits";

const MAX_DEPTH = 3;

/**
 * One initiative: how far it has got (rolled up from every project below, each ticket once), the initiatives under it, and the
 * projects it groups. Projects of teams the viewer is not on are not listed: they are only counted and added to the totals.
 */
export function InitiativeView(props: { initiative: InitiativeDetail }) {
  const { api, queryClient } = useServices();
  const navigate = useNavigate();
  const i = props.initiative;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<InitiativeDraft>(() => draftOf(i));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const { confirm, dialogs } = useDialogs();
  const [link, setLink] = useState("");
  const [sub, setSub] = useState("");

  /** Run a change; show a refusal where the person is looking, and read everything again after it. */
  const run = (fn: () => Promise<unknown>, after?: () => void) =>
    start(async () => {
      try {
        await fn();
      } catch (e) {
        return setError(describeFailure(e));
      }
      setError(null);
      await refreshAll(queryClient);
      after?.();
    });

  const save = () => run(() => api.initiatives.update(i.id, inputOf(draft, { create: false, version: i.version })), () => setEditing(false));

  const remove = async () => {
    const below = i.childCount;
    const description = below ? `The ${below} initiative${below === 1 ? "" : "s"} under it move up a level. The projects stay as they are.` : "The projects stay as they are.";
    if (!(await confirm({ title: `Delete "${i.name}"?`, description, confirmLabel: "Delete", danger: true }))) return;
    run(() => api.initiatives.delete(i.id), () => navigate(i.parentId ? `/initiatives/${i.parentId}` : "/initiatives"));
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <nav className="flex flex-wrap items-center gap-1 text-xs text-muted" aria-label="Where this sits">
          <Link to="/initiatives" className="hover:text-fg">
            All initiatives
          </Link>
          {i.path.map((p) => (
            <span key={p.id}>
              {" / "}
              <Link to={`/initiatives/${p.id}`} className="hover:text-fg">
                {p.name}
              </Link>
            </span>
          ))}
        </nav>
        <div className="mt-2 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold">{i.name}</h2>
              {initiativeStatusChip(i.status)}
              <HealthChip health={i.health} />
            </div>
            <p className="mt-1 text-sm text-muted">
              {i.owner ? `Owned by ${i.owner.name}` : "No owner"} · {targetOf(i)}
            </p>
            {i.description && <p className="mt-2 whitespace-pre-wrap text-sm">{i.description}</p>}
            <div className="mt-3">
              <Progress done={i.done} total={i.total} />
            </div>
          </div>
          {i.canEdit && !editing && (
            <div className="flex shrink-0 gap-2 text-xs">
              <button className="btn" onClick={() => (setDraft(draftOf(i)), setError(null), setEditing(true))}>
                Edit
              </button>
              <button className="btn text-danger" disabled={pending} onClick={() => void remove()}>
                Delete
              </button>
            </div>
          )}
        </div>

        {editing && (
          <div className="mt-4">
            <InitiativeForm draft={draft} onChange={setDraft} onSubmit={save} onCancel={() => (setEditing(false), setError(null))} submitLabel="Save" pending={pending} error={error} />
          </div>
        )}
        {!editing && error && <p className="mt-3 text-sm text-danger" role="alert">{error}</p>}

        {i.canEdit && i.status === "active" && (
          <div className="mt-4 flex items-center gap-2 text-sm">
            <span className="label">Health</span>
            <Select
              ariaLabel="Health"
              value={i.health.override ?? "auto"}
              options={[{ value: "auto", label: i.health.derived ? `Worked out: ${healthLabel(i.health.derived)}` : "Worked out" }, ...HEALTHS.map((h) => ({ value: h, label: healthLabel(h) }))]}
              onValueChange={(v) => run(() => api.initiatives.update(i.id, { healthOverride: v === "auto" ? null : (v as ProjectHealthValue), version: i.version }))}
            />
          </div>
        )}

        <section className="mt-6" aria-label="Initiatives below">
          <h3 className="label mb-2">Initiatives below</h3>
          {i.children.length === 0 && <p className="text-sm text-muted">None.</p>}
          <ul className="space-y-1.5">
            {i.children.map((c) => (
              <li key={c.id}>
                <Link to={`/initiatives/${c.id}`} className="card block px-3 py-2 hover:border-muted/50">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">{c.name}</span>
                    {initiativeStatusChip(c.status)}
                    <HealthChip health={c.health} />
                  </div>
                  <Progress done={c.done} total={c.total} />
                </Link>
              </li>
            ))}
          </ul>
          {i.canEdit && i.depth < MAX_DEPTH && (
            <form
              className="mt-2 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!sub.trim()) return;
                run(() => api.initiatives.create({ name: sub.trim(), parentId: i.id }), () => setSub(""));
              }}
            >
              <input className="input flex-1" placeholder="New initiative under this one" aria-label="New sub-initiative" value={sub} onChange={(e) => setSub(e.target.value)} />
              <button className="btn" type="submit" disabled={pending || !sub.trim()}>
                Add initiative
              </button>
            </form>
          )}
          {i.canEdit && i.depth >= MAX_DEPTH && <p className="mt-2 text-xs text-muted">Initiatives nest {MAX_DEPTH} levels deep, so nothing more fits under this one.</p>}
        </section>

        <section className="mt-6" aria-label="Projects">
          <h3 className="label mb-2">Projects</h3>
          {i.projects.length === 0 && i.hidden.count === 0 && <p className="text-sm text-muted">No projects yet.</p>}
          <ul className="space-y-1.5">
            {i.projects.map((p) => (
              <li key={p.id} className="card flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Link to={`/projects/${p.id}`} className="font-medium hover:underline">
                      {p.name}
                    </Link>
                    {projectStatusChip(p.status)}
                    <HealthChip health={p.health} />
                    {!p.direct && <span className="text-xs text-muted">through a sub-initiative</span>}
                  </div>
                  <Progress done={p.done} total={p.total} />
                </div>
                {i.canEdit && p.direct && (
                  <button className="text-xs text-muted hover:text-danger" disabled={pending} aria-label={`Remove ${p.name}`} onClick={() => run(() => api.initiatives.unlinkProject(i.id, p.id))}>
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
          {i.hidden.count > 0 && (
            <p className="mt-1.5 rounded-md border border-dashed border-line px-4 py-3 text-sm text-muted" data-hidden>
              {i.hidden.count} other project{i.hidden.count === 1 ? "" : "s"} of teams you are not in: {i.hidden.done} of {i.hidden.total} ticket{i.hidden.total === 1 ? "" : "s"} done.
            </p>
          )}
          {i.canEdit && i.linkable.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Select ariaLabel="Project to add" value={link} placeholder="Add a project" options={i.linkable.map((p) => ({ value: p.id, label: p.name }))} onValueChange={setLink} />
              <button className="btn" disabled={!link || pending} onClick={() => run(() => api.initiatives.linkProject(i.id, link), () => setLink(""))}>
                Add project
              </button>
            </div>
          )}
        </section>
      </div>
      {dialogs}
    </div>
  );
}
