import { useState, useTransition } from "react";
import { Link, useNavigate } from "../../lib/workspace";
import type { ProjectSummary } from "@wheelhouse/api-client";
import { PRIORITY_LABEL, PriorityIcon } from "../../components/priority-icon";
import { describeFailure } from "../../lib/form-state";
import { refreshAll } from "../../lib/refresh";
import { useServices } from "../../lib/services";
import { useTeams } from "../../lib/session";
import { Progress } from "../cycles/cycle-bits";
import { dateRange, HealthChip, inputOf, newDraft, ProjectForm, statusChip, type ProjectDraft } from "./project-bits";
import { Page } from "../../components/page";

/**
 * The projects the person can see: outcomes that end and can span teams. A project is visible through a team of yours that takes
 * part; the teams you are not on are only counted, here and on the project's page.
 */
export function Projects(props: { projects: ProjectSummary[] }) {
  const { api, queryClient } = useServices();
  const navigate = useNavigate();
  const teams = useTeams().data ?? [];
  // The server refuses a team the person cannot edit; the form offers every team they are not only a viewer on.
  const editable = teams.filter((t) => t.role !== "viewer");
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<ProjectDraft>(newDraft());
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const create = () =>
    start(async () => {
      try {
        const p = await api.projects.create(inputOf(draft, { create: true }));
        await refreshAll(queryClient);
        navigate(`/projects/${p.id}`);
      } catch (e) {
        setError(describeFailure(e));
      }
    });

  return (
    <Page
      title="Projects"
      hint="An outcome that ends: a launch, a migration. A project can span several teams, each keeping its own board; you see the issues of the teams you are on and only totals for the others."
      action={<button className="btn btn-primary shrink-0" onClick={() => (setDraft(newDraft(editable[0]?.key ?? "")), setError(null), setCreating(true))}>+ New project</button>}
    >
      {creating && <div className="mb-4"><ProjectForm draft={draft} onChange={setDraft} onSubmit={create} onCancel={() => (setCreating(false), setError(null))} submitLabel="Create project" pending={pending} error={error} teams={editable} /></div>}
      {props.projects.length === 0 && !creating && <p className="py-6 text-center text-sm text-muted">No projects yet. A project appears here for everyone on a team that takes part in it.</p>}
      {props.projects.length > 0 && (
        <ul className="card divide-y divide-line overflow-hidden">
          {props.projects.map((p) => (
            <li key={p.id}>
              <Link to={`/projects/${p.id}`} className="group flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm transition-colors hover:bg-panel-2/70">
                <span className="min-w-0 flex-1 truncate group-hover:underline">{p.name}</span>
                {statusChip(p.status)}
                <HealthChip health={p.health} />
                <span className="text-xs text-muted">{dateRange(p)}</span>
                <span className="text-xs text-muted">
                  {p.leadUser ? p.leadUser.name : "No lead"} · {p.teamCount} team{p.teamCount === 1 ? "" : "s"}
                </span>
                <Progress done={p.done} total={p.total} />
                {p.priority !== "none" && (
                  <span className="chip bg-panel-2 text-muted" data-priority-chip title={PRIORITY_LABEL[p.priority]} aria-label={PRIORITY_LABEL[p.priority]}>
                    <PriorityIcon priority={p.priority} />
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
