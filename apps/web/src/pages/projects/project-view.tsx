import { useState, useTransition } from "react";
import { Link, useNavigate } from "react-router";
import clsx from "clsx";
import { ApiError, type ProjectDetail, type ProjectHealthValue } from "@wheelhouse/api-client";
import { CheckIcon } from "../../components/icons";
import { Select, useDialogs } from "../../components/ui";
import { describeFailure } from "../../lib/form-state";
import { refreshAll } from "../../lib/refresh";
import { useServices } from "../../lib/services";
import { Progress } from "../cycles/cycle-bits";
import { day, dateRange, draftOf, HEALTHS, healthLabel, HealthChip, inputOf, ProjectForm, statusChip, type ProjectDraft } from "./project-bits";

/** One project: what it is for, how it is going, its milestones, and the teams taking part (the viewer's own with their issues, the others as totals). */
export function ProjectView(props: { project: ProjectDetail }) {
  const { api, queryClient } = useServices();
  const navigate = useNavigate();
  const p = props.project;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ProjectDraft>(() => draftOf(p));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const { confirm, prompt, dialogs } = useDialogs();
  const [msName, setMsName] = useState("");
  const [msDate, setMsDate] = useState("");
  const [addTeam, setAddTeam] = useState("");

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

  const save = () => run(() => api.projects.update(p.id, inputOf(draft, { create: false, version: p.version })), () => setEditing(false));

  const remove = async () => {
    const issues = p.total;
    if (!(await confirm({ title: `Delete "${p.name}"?`, description: issues ? `Its ${issues} issue${issues === 1 ? "" : "s"} stay on their boards, in no project.` : undefined, confirmLabel: "Delete", danger: true }))) return;
    run(() => api.projects.delete(p.id), () => navigate("/projects"));
  };

  const takeOut = (teamKey: string, name: string) =>
    start(async () => {
      try {
        await api.projects.removeTeam(p.id, teamKey);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && /issue/.test(e.message)) {
          if (!(await confirm({ title: `Take ${name} out?`, description: `${e.message} Taking the team out releases them: they stay on the team's board, in no project.`, confirmLabel: "Release and take out", danger: true }))) return;
          try {
            await api.projects.removeTeam(p.id, teamKey, { releaseIssues: true });
          } catch (e2) {
            return setError(describeFailure(e2));
          }
        } else return setError(describeFailure(e));
      }
      setError(null);
      await refreshAll(queryClient);
    });

  const milestoneName = (id: string | null) => (id ? p.milestones.find((m) => m.id === id)?.name : undefined);

  return (
    <div className="h-full overflow-y-auto">
      <div className="w-full px-6 py-6">
        <Link to="/projects" className="text-xs text-muted hover:text-fg">
          ← All projects
        </Link>
        <div className="mt-2 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold">{p.name}</h2>
              {statusChip(p.status)}
              <HealthChip health={p.health} />
            </div>
            <p className="mt-1 text-sm text-muted">
              {p.leadUser ? `Led by ${p.leadUser.name}` : "No lead"} · {dateRange(p)} · {p.teamCount} team{p.teamCount === 1 ? "" : "s"}
            </p>
            {p.description && <p className="mt-2 whitespace-pre-wrap text-sm">{p.description}</p>}
            <div className="mt-3">
              <Progress done={p.done} total={p.total} />
            </div>
          </div>
          {p.canEdit && !editing && (
            <div className="flex shrink-0 gap-2 text-xs">
              <button className="btn" onClick={() => (setDraft(draftOf(p)), setError(null), setEditing(true))}>
                Edit
              </button>
              {p.canAdmin && (
                <button className="btn text-danger" disabled={pending} onClick={() => void remove()}>
                  Delete
                </button>
              )}
            </div>
          )}
        </div>

        {editing && (
          <div className="mt-4">
            <ProjectForm draft={draft} onChange={setDraft} onSubmit={save} onCancel={() => (setEditing(false), setError(null))} submitLabel="Save" pending={pending} error={error} />
          </div>
        )}
        {!editing && error && <p className="mt-3 text-sm text-danger" role="alert">{error}</p>}

        {p.canEdit && p.status === "active" && (
          <div className="mt-4 flex items-center gap-2 text-sm">
            <span className="label">Health</span>
            <Select
              ariaLabel="Health"
              value={p.health.override ?? "auto"}
              options={[{ value: "auto", label: p.health.derived ? `Worked out: ${healthLabel(p.health.derived)}` : "Worked out" }, ...HEALTHS.map((h) => ({ value: h, label: healthLabel(h) }))]}
              onValueChange={(v) => run(() => api.projects.update(p.id, { healthOverride: v === "auto" ? null : (v as ProjectHealthValue), version: p.version }))}
            />
          </div>
        )}

        <section className="mt-6" aria-label="Milestones">
          <h3 className="label mb-2">Milestones</h3>
          {p.milestones.length === 0 && <p className="text-sm text-muted">No milestones yet.</p>}
          <ul className="space-y-1.5">
            {p.milestones.map((m, i) => (
              <li key={m.id} className="card flex items-center gap-3 px-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{m.name}</span>
                    {m.targetDate && <span className="text-xs text-muted">{day(m.targetDate)}</span>}
                  </div>
                  <Progress done={m.done} total={m.total} />
                </div>
                {p.canEdit && (
                  <div className="flex gap-2 text-xs text-muted">
                    <button className="hover:text-fg disabled:opacity-30" disabled={i === 0 || pending} aria-label={`Move ${m.name} up`} onClick={() => run(() => api.projects.updateMilestone(p.id, m.id, { index: i - 1 }))}>
                      Up
                    </button>
                    <button className="hover:text-fg disabled:opacity-30" disabled={i === p.milestones.length - 1 || pending} aria-label={`Move ${m.name} down`} onClick={() => run(() => api.projects.updateMilestone(p.id, m.id, { index: i + 1 }))}>
                      Down
                    </button>
                    <button
                      className="hover:text-fg"
                      aria-label={`Rename ${m.name}`}
                      onClick={async () => {
                        const name = await prompt({ title: "Rename the milestone", placeholder: m.name, confirmLabel: "Rename" });
                        if (name && name.trim() && name.trim() !== m.name) run(() => api.projects.updateMilestone(p.id, m.id, { name: name.trim() }));
                      }}
                    >
                      Rename
                    </button>
                    <button
                      className="hover:text-danger"
                      aria-label={`Delete ${m.name}`}
                      onClick={async () => {
                        if (await confirm({ title: `Delete "${m.name}"?`, description: m.total ? `Its ${m.total} issue${m.total === 1 ? "" : "s"} stay in the project, in no milestone.` : undefined, confirmLabel: "Delete", danger: true })) run(() => api.projects.deleteMilestone(p.id, m.id));
                      }}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {p.canEdit && (
            <form
              className="mt-2 flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!msName.trim()) return;
                run(() => api.projects.addMilestone(p.id, { name: msName.trim(), targetDate: msDate || null }), () => (setMsName(""), setMsDate("")));
              }}
            >
              <input className="input min-w-40 flex-1" placeholder="New milestone" aria-label="New milestone" value={msName} onChange={(e) => setMsName(e.target.value)} />
              <input className="input w-40" type="date" aria-label="Milestone date" value={msDate} onChange={(e) => setMsDate(e.target.value)} />
              <button className="btn" type="submit" disabled={pending || !msName.trim()}>
                Add milestone
              </button>
            </form>
          )}
        </section>

        <section className="mt-6" aria-label="Teams">
          <h3 className="label mb-2">Teams</h3>
          <div className="space-y-3">
            {p.teams.map((t) => (
              <div key={t.key} className="card px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Link to={`/t/${t.key}`} className="font-semibold hover:underline">
                    {t.name}
                  </Link>
                  <span className="chip bg-panel-2 text-muted">{t.key}</span>
                  {t.lead && <span className="chip bg-accent/15 text-accent">lead team</span>}
                  <span className="ml-auto" />
                  {!t.lead && (p.canEdit || t.role === "admin") && (
                    <button className="text-xs text-muted hover:text-danger" disabled={pending} aria-label={`Take ${t.name} out`} onClick={() => takeOut(t.key, t.name)}>
                      Take out
                    </button>
                  )}
                </div>
                <div className="mt-1">
                  <Progress done={t.done} total={t.total} />
                </div>
                {t.issues.length > 0 && (
                  <ul className="mt-2 divide-y divide-line text-sm">
                    {t.issues.map((x) => (
                      <li key={x.ref} className="flex items-center gap-2 py-1.5">
                        <span className={clsx("flex w-4 justify-center", x.done ? "text-ok" : "text-muted")} role="img" aria-label={x.done ? "done" : "open"}>
                          {x.done ? <CheckIcon /> : <span className="inline-block size-2.5 rounded-full border border-muted" />}
                        </span>
                        <Link to={`/t/${t.key}?t=${encodeURIComponent(x.ref)}`} className={clsx("min-w-0 flex-1 truncate hover:underline", x.done && "text-muted line-through")}>
                          <span className="font-mono text-[11px] text-muted">{x.ref}</span> {x.title}
                        </Link>
                        {milestoneName(x.milestoneId) && <span className="chip bg-accent/10 text-accent/90">{milestoneName(x.milestoneId)}</span>}
                        <span className="chip bg-panel-2 text-muted">{x.status}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
            {p.others.count > 0 && (
              <p className="rounded-md border border-dashed border-line px-4 py-3 text-sm text-muted" data-others>
                {p.others.count} team{p.others.count === 1 ? "" : "s"} you are not in: {p.others.done} of {p.others.total} issue{p.others.total === 1 ? "" : "s"} done.
              </p>
            )}
          </div>
          {p.canEdit && p.addableTeams.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Select ariaLabel="Team to bring in" value={addTeam} placeholder="Bring in a team" options={p.addableTeams.map((t) => ({ value: t.key, label: `${t.name} (${t.key})` }))} onValueChange={setAddTeam} />
              <button className="btn" disabled={!addTeam || pending} onClick={() => run(() => api.projects.addTeam(p.id, addTeam), () => setAddTeam(""))}>
                Bring in
              </button>
            </div>
          )}
        </section>
      </div>
      {dialogs}
    </div>
  );
}
