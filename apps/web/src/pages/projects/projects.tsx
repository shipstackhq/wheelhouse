import { useState, useTransition } from "react";
import { Link, useNavigate } from "react-router";
import type { ProjectSummary } from "@wheelhouse/api-client";
import { describeFailure } from "../../lib/form-state";
import { refreshAll } from "../../lib/refresh";
import { useServices } from "../../lib/services";
import { useTeams } from "../../lib/session";
import { Progress } from "../cycles/cycle-bits";
import { dateRange, HealthChip, inputOf, newDraft, ProjectForm, statusChip, type ProjectDraft } from "./project-bits";

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
    <div className="h-full overflow-y-auto">
      <div className="w-full px-6 py-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Projects</h2>
            <p className="mt-1 text-sm text-muted">
              An outcome that ends: a launch, a migration. A project can span several teams, each keeping its own board; you see the tickets of
              the teams you are on and only totals for the others.
            </p>
          </div>
          <button className="btn btn-primary shrink-0" onClick={() => (setDraft(newDraft(editable[0]?.key ?? "")), setError(null), setCreating(true))}>
            + New project
          </button>
        </div>
        <div className="mt-5 space-y-2">
          {creating && <ProjectForm draft={draft} onChange={setDraft} onSubmit={create} onCancel={() => (setCreating(false), setError(null))} submitLabel="Create project" pending={pending} error={error} teams={editable} />}
          {props.projects.length === 0 && !creating && <p className="py-6 text-center text-sm text-muted">No projects yet. A project appears here for everyone on a team that takes part in it.</p>}
          {props.projects.map((p) => (
            <Link key={p.id} to={`/projects/${p.id}`} className="card block px-4 py-3 hover:border-muted/50">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{p.name}</span>
                {statusChip(p.status)}
                <HealthChip health={p.health} />
                <span className="text-sm text-muted">{dateRange(p)}</span>
              </div>
              <p className="mt-1 text-sm text-muted">
                {p.leadUser ? `Led by ${p.leadUser.name}` : "No lead"} · {p.teamCount} team{p.teamCount === 1 ? "" : "s"}
              </p>
              <div className="mt-2">
                <Progress done={p.done} total={p.total} />
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
