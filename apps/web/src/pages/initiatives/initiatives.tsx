import { useState, useTransition } from "react";
import { Link, useNavigate } from "../../lib/workspace";
import type { InitiativeSummary } from "@wheelhouse/api-client";
import { describeFailure } from "../../lib/form-state";
import { refreshAll } from "../../lib/refresh";
import { useServices } from "../../lib/services";
import { Progress } from "../cycles/cycle-bits";
import { HealthChip } from "../projects/project-bits";
import { initiativeStatusChip, InitiativeForm, inputOf, newDraft, targetOf, type InitiativeDraft } from "./initiative-bits";
import { Page } from "../../components/page";

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
    <Page
      title="Initiatives"
      hint={`A goal that groups projects, and smaller initiatives under it (up to ${MAX_DEPTH} levels). Progress rolls up from the issues of everything below; you see the projects of your own teams and only totals for the rest.`}
      action={<button className="btn btn-primary shrink-0" onClick={() => (setDraft(newDraft()), setError(null), setCreating(true))}>+ New initiative</button>}
    >
      {creating && <div className="mb-4"><InitiativeForm draft={draft} onChange={setDraft} onSubmit={create} onCancel={() => (setCreating(false), setError(null))} submitLabel="Create initiative" pending={pending} error={error} parents={parents} /></div>}
      {props.initiatives.length === 0 && !creating && <p className="py-6 text-center text-sm text-muted">No initiatives yet. Start one to group the projects that work towards the same goal.</p>}
      {props.initiatives.length > 0 && (
        <ul className="card divide-y divide-line overflow-hidden">
          {props.initiatives.map((i) => (
            <li key={i.id}>
              <Link to={`/initiatives/${i.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm transition-colors hover:bg-panel-2/70 hover:underline" style={{ paddingLeft: `${1 + (i.depth - 1) * 1.5}rem` }}>
                <span className="min-w-0 flex-1 truncate">{i.name}</span>
                {initiativeStatusChip(i.status)}
                <HealthChip health={i.health} />
                <span className="text-xs text-muted">{targetOf(i)}</span>
                <span className="text-xs text-muted">
                  {i.owner ? i.owner.name : "No owner"} · {i.projectCount} project{i.projectCount === 1 ? "" : "s"}
                  {i.childCount > 0 && ` · ${i.childCount} sub-initiative${i.childCount === 1 ? "" : "s"}`}
                </span>
                <Progress done={i.done} total={i.total} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
