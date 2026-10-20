import { useState, useTransition } from "react";
import { Link } from "react-router";
import type { CycleList, CycleSummary } from "@wheelhouse/api-client";
import { describeFailure } from "../../lib/form-state";
import { refreshAll } from "../../lib/refresh";
import { useServices } from "../../lib/services";
import { CycleForm, cycleRange, cycleTiming, cycleTitle, inputOf, newDraft, Progress, stateChip, useDraft } from "./cycle-bits";

/**
 * A team's cycles: the one running now, those coming, those behind it. Cycles are optional; a team that never makes one
 * sees nothing of them on the board except the filter.
 */
export function Cycles(props: { teamKey: string; list: CycleList }) {
  const { api, queryClient } = useServices();
  const { teamKey, list } = props;
  const [creating, setCreating] = useState(false);
  const { draft, setDraft, error, setError } = useDraft(newDraft);
  const [pending, start] = useTransition();
  const none = !list.current && list.upcoming.length === 0 && list.past.length === 0;

  const create = () =>
    start(async () => {
      try {
        await api.cycles.create(teamKey, inputOf(draft, { withDates: true }));
      } catch (e) {
        return setError(describeFailure(e));
      }
      setCreating(false);
      setError(null);
      await refreshAll(queryClient);
    });

  const row = (c: CycleSummary) => (
    <Link key={c.number} to={`/t/${teamKey}/cycles/${c.number}`} className="card block px-4 py-3 hover:border-muted/50">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{cycleTitle(c)}</span>
        {stateChip(c.state)}
        <span className="text-sm text-muted">
          {cycleRange(c)} · {cycleTiming(c)}
        </span>
      </div>
      {c.goal && <p className="mt-1 text-sm text-muted">{c.goal}</p>}
      <div className="mt-2">
        <Progress done={c.done} total={c.total} />
      </div>
    </Link>
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Cycles</h2>
            <p className="mt-1 text-sm text-muted">
              An optional rhythm for this team: one or two weeks with a goal. Tickets join when they are ready, not at the start, and what is
              not done when a cycle ends moves on to the next one by itself. There are no points and no velocity.
            </p>
          </div>
          <button className="btn btn-primary shrink-0" onClick={() => (setDraft(newDraft()), setError(null), setCreating(true))}>
            + New cycle
          </button>
        </div>

        <div className="mt-5 space-y-5">
          {creating && <CycleForm draft={draft} onChange={setDraft} onSubmit={create} onCancel={() => (setCreating(false), setError(null))} submitLabel="Start the cycle" pending={pending} error={error} />}
          {none && !creating && <p className="py-6 text-center text-sm text-muted">No cycles yet. Make one when the team wants a rhythm; until then the board works as it always did.</p>}
          {list.current && (
            <section aria-label="Current cycle">
              <h3 className="label mb-2">Current</h3>
              {row(list.current)}
            </section>
          )}
          {list.upcoming.length > 0 && (
            <section aria-label="Upcoming cycles">
              <h3 className="label mb-2">Upcoming</h3>
              <div className="space-y-2">{list.upcoming.map(row)}</div>
            </section>
          )}
          {list.past.length > 0 && (
            <section aria-label="Past cycles">
              <h3 className="label mb-2">Past</h3>
              <div className="space-y-2">{list.past.map(row)}</div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
