import { useState, useTransition } from "react";
import { useQueries } from "@tanstack/react-query";
import { Link, useNavigate } from "../../lib/workspace";
import clsx from "clsx";
import { DropdownMenu } from "radix-ui";
import { ApiError, type Priority, type ProjectDetail, type ProjectHealthValue } from "@wheelhouse/api-client";
import { CheckIcon, ChevronDownIcon, UserIcon } from "../../components/icons";
import { Avatar } from "../../components/avatar";
import { PRIORITY_LABEL, PRIORITY_ORDER, PriorityIcon } from "../../components/priority-icon";
import { RichTextField } from "../../components/rich-text-field";
import { usePageMenu } from "../../components/page-menu";
import { Select, useDialogs } from "../../components/ui";
import { describeFailure } from "../../lib/form-state";
import { refreshAll } from "../../lib/refresh";
import { useServices } from "../../lib/services";
import { Progress } from "../cycles/cycle-bits";
import { day, dateRange, draftOf, HEALTHS, healthLabel, HealthChip, inputOf, ProjectForm, statusChip, type ProjectDraft } from "./project-bits";

/** The pills in the properties and resources strips: all the same height, whatever is in them (an avatar, an icon, plain text). */
const PILL = "h-6 gap-2 rounded-full px-2 text-xs font-normal";

/** The priority as a pill; for someone who can edit, the pill is the menu that changes it. */
function PriorityPill({ priority, onChange }: { priority: Priority; onChange?: (priority: Priority) => void }) {
  const look = clsx("chip inline-flex items-center bg-card text-fg", PILL);
  const label = (
    <>
      <PriorityIcon priority={priority} />
      {PRIORITY_LABEL[priority]}
    </>
  );
  if (!onChange)
    return (
      <span className={look} data-priority-pill>
        {label}
      </span>
    );
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger aria-label={`Priority: ${PRIORITY_LABEL[priority]}`} className={clsx(look, "cursor-pointer outline-none hover:bg-fg/[0.07] focus-visible:ring-2 focus-visible:ring-accent/50")} data-priority-pill>
        {label}
        <ChevronDownIcon className="opacity-70" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={4} className="z-60 min-w-44 rounded-lg border border-line bg-panel p-1 shadow-lg">
          {PRIORITY_ORDER.map((p) => (
            <DropdownMenu.Item key={p} onSelect={() => p !== priority && onChange(p)} className="flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-fg outline-none data-[highlighted]:bg-fg/[0.07]">
              <PriorityIcon priority={p} />
              {PRIORITY_LABEL[p]}
              {p === priority && <CheckIcon className="ml-auto text-muted" />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

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

  // Edit and Delete are in the header's menu, at the end of the breadcrumbs, while this page is open.
  usePageMenu(
    p.canEdit && !editing
      ? [{ label: "Edit", onSelect: () => (setDraft(draftOf(p)), setError(null), setEditing(true)) }, ...(p.canAdmin ? [{ label: "Delete", danger: true, disabled: pending, onSelect: () => void remove() }] : [])]
      : [],
  );

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
        <h2 className="mt-2 min-w-0 text-2xl font-semibold">{p.name}</h2>

        <section aria-label="Properties" className="mt-3 flex flex-wrap items-center gap-2">
          <h3 className="label mr-1">Properties</h3>
          {statusChip(p.status, PILL)}
          <HealthChip health={p.health} className={PILL} />
          <PriorityPill priority={p.priority} onChange={p.canEdit ? (priority) => run(() => api.projects.update(p.id, { priority, version: p.version })) : undefined} />
          {p.leadUser ? (
            <span className={clsx("chip inline-flex items-center bg-card text-fg", PILL)}>
              <Avatar name={p.leadUser.name} imageUrl={p.leadUser.avatarUrl} className="size-4 text-[8px]" />
              {p.leadUser.name}
            </span>
          ) : (
            <span className={clsx("chip inline-flex items-center bg-card text-muted", PILL)}>
              <UserIcon className="text-base" />
              Lead not assigned
            </span>
          )}
          <span className={clsx("chip bg-card text-fg", PILL)}>Primary team: {p.leadTeam ? p.leadTeam.name : "none"}</span>
          <span className={clsx("chip bg-card text-fg", PILL)}>{dateRange(p)}</span>
          <span className={clsx("chip bg-card text-fg", PILL)}>
            {p.done} of {p.total} issue{p.total === 1 ? "" : "s"} done
          </span>
          {p.canEdit && p.status === "active" && (
            <Select
              ariaLabel="Health"
              triggerClassName="h-6 py-0"
              value={p.health.override ?? "auto"}
              options={[{ value: "auto", label: p.health.derived ? `Worked out: ${healthLabel(p.health.derived)}` : "Worked out" }, ...HEALTHS.map((h) => ({ value: h, label: healthLabel(h) }))]}
              onValueChange={(v) => run(() => api.projects.update(p.id, { healthOverride: v === "auto" ? null : (v as ProjectHealthValue), version: p.version }))}
            />
          )}
        </section>

        <section aria-label="Resources" className="mt-2 flex flex-wrap items-center gap-2">
          <h3 className="label mr-1">Resources</h3>
          {p.teams.map((t) => (
            <Link key={t.key} to={`/t/${t.key}`} className={clsx("chip bg-card text-fg hover:underline", PILL)}>
              {t.name}
              {t.lead && <span className="text-accent"> · lead team</span>}
              <span className="text-muted">
                {" "}
                · {t.done} of {t.total}
              </span>
            </Link>
          ))}
          {p.others.count > 0 && (
            <span className={clsx("chip border border-dashed border-line text-muted", PILL)} data-others>
              {p.others.count} team{p.others.count === 1 ? "" : "s"} you are not in: {p.others.done} of {p.others.total} issue{p.others.total === 1 ? "" : "s"} done.
            </span>
          )}
        </section>

        {(p.description || p.canEdit) && (
          <div className="mt-4">
            <RichTextField value={p.description} label="Description" readOnly={!p.canEdit} onCommit={(description) => run(() => api.projects.update(p.id, { description, version: p.version }))} />
          </div>
        )}
        {editing && (
          <div className="mt-4">
            <ProjectForm draft={draft} onChange={setDraft} onSubmit={save} onCancel={() => (setEditing(false), setError(null))} submitLabel="Save" pending={pending} error={error} />
          </div>
        )}
        {!editing && error && <p className="mt-3 text-sm text-danger" role="alert">{error}</p>}

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

        <ProjectRepositories project={p} pending={pending} run={run} />

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

/**
 * Where the project's work happens (WH-135): its repositories, each with the branch its issues start from. One repository settles the
 * targets of every issue in the project that has none of its own; several are suggested on each issue.
 */
function ProjectRepositories({ project: p, pending, run }: { project: ProjectDetail; pending: boolean; run: (fn: () => Promise<unknown>) => void }) {
  const { api } = useServices();
  const lists = useQueries({ queries: p.teams.map((t) => ({ queryKey: ["team-repos", t.key], queryFn: () => api.repos.list(t.key) })) });
  const options = lists.flatMap((q) => q.data ?? []).filter((r) => r.provider === "github" && r.githubFullName && !p.repositories.some((x) => x.repositoryId === r.id));
  const current = p.repositories.map((r) => ({ repository: r.repositoryId, branch: r.branch }));
  const save = (repositories: { repository: string; branch?: string }[]) => run(() => api.projects.update(p.id, { repositories, version: p.version }));
  if (!p.repositories.length && !options.length) return null;
  return (
    <section className="mt-6" aria-label="Repositories">
      <h3 className="label mb-2">Repositories</h3>
      <ul className="space-y-1 text-sm">
        {p.repositories.map((r, i) => (
          <li key={r.repositoryId} className="flex items-center gap-2">
            <span className="font-mono text-xs">{r.repository}</span>
            <span className="text-muted">from {r.branch}</span>
            {p.canEdit && (
              <button type="button" className="btn py-0.5 text-xs" disabled={pending} aria-label={`Remove ${r.repository}`} onClick={() => save(current.filter((_, j) => j !== i))}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {p.canEdit && options.length > 0 && (
        <Select className="mt-2 !w-auto" ariaLabel="Add repository" value="" placeholder="Add a repository…" options={options.map((r) => ({ value: r.id, label: r.githubFullName! }))} onValueChange={(v) => v && save([...current, { repository: v }])} />
      )}
    </section>
  );
}
