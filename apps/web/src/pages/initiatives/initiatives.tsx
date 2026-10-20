import { useState, useTransition } from "react";
import { Link, useNavigate } from "react-router";
import type { InitiativeSummary } from "@wheelhouse/api-client";
import { describeFailure } from "../../lib/form-state";
import { refreshAll } from "../../lib/refresh";
import { useServices } from "../../lib/services";
import { Progress } from "../cycles/cycle-bits";
import { HealthChip } from "../projects/project-bits";
import { initiativeStatusChip, InitiativeForm, inputOf, newDraft, targetOf, type InitiativeDraft } from "./initiative-bits";

const MAX_DEPTH = 3;

/**
 * Every initiative of the workspace, nested under its parent. An initiative groups projects (and other initiatives) and shows how far
 * the issues of all of them have got; the projects of teams you are not on count in the totals but are never named.
 */
export function Initiatives(props: { initiatives: InitiativeSummary[] }) {
  const { api, queryClient } = useServices();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<InitiativeDraft>(newDraft());
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // The server answers parents before their children, so the order here is already the tree's.
  const parents = props.initiatives.filter((i) => i.depth < MAX_DEPTH && i.canEdit).map((i) => ({ id: i.id, name: `${"– ".repeat(i.depth - 1)}${i.name}` }));

  const create = () =>
    start(async () => {
      try {
        const i = await api.initiatives.create(inputOf(draft, { create: true }));
        await refreshAll(queryClient);
        navigate(`/initiatives/${i.id}`);
      } catch (e) {
        setError(describeFailure(e));
      }
    });

  return (
    <div className="h-full overflow-y-auto">
      <div className="w-full px-6 py-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Initiatives</h2>
            <p className="mt-1 text-sm text-muted">
              A goal that groups projects, and smaller initiatives under it (up to {MAX_DEPTH} levels). Progress rolls up from the issues of everything
              below; you see the projects of your own teams and only totals for the rest.
            </p>
          </div>
          <button className="btn btn-primary shrink-0" onClick={() => (setDraft(newDraft()), setError(null), setCreating(true))}>
            + New initiative
          </button>
        </div>
        <div className="mt-5 space-y-2">
          {creating && <InitiativeForm draft={draft} onChange={setDraft} onSubmit={create} onCancel={() => (setCreating(false), setError(null))} submitLabel="Create initiative" pending={pending} error={error} parents={parents} />}
          {props.initiatives.length === 0 && !creating && <p className="py-6 text-center text-sm text-muted">No initiatives yet. Start one to group the projects that work towards the same goal.</p>}
          {props.initiatives.map((i) => (
            <Link key={i.id} to={`/initiatives/${i.id}`} className="card block px-4 py-3 hover:border-muted/50" style={{ marginLeft: `${(i.depth - 1) * 1.5}rem` }}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{i.name}</span>
                {initiativeStatusChip(i.status)}
                <HealthChip health={i.health} />
                <span className="text-sm text-muted">{targetOf(i)}</span>
              </div>
              <p className="mt-1 text-sm text-muted">
                {i.owner ? `Owned by ${i.owner.name}` : "No owner"} · {i.projectCount} project{i.projectCount === 1 ? "" : "s"}
                {i.childCount > 0 && ` · ${i.childCount} sub-initiative${i.childCount === 1 ? "" : "s"}`}
              </p>
              <div className="mt-2">
                <Progress done={i.done} total={i.total} />
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
