import { useState, useTransition } from "react";
import { Link, useNavigate } from "react-router";
import clsx from "clsx";
import type { CycleDetail } from "@wheelhouse/api-client";
import { CheckIcon } from "../../components/icons";
import { useDialogs } from "../../components/ui";
import { describeFailure } from "../../lib/form-state";
import { refreshAll } from "../../lib/refresh";
import { useServices } from "../../lib/services";
import { CycleForm, cycleRange, cycleTiming, cycleTitle, draftOf, inputOf, Progress, stateChip, useDraft } from "./cycle-bits";

/** One cycle: what it is for, the tickets in it, and what landed (reached Done) while it ran. */
export function CycleView(props: { teamKey: string; cycle: CycleDetail }) {
  const { api, queryClient } = useServices();
  const navigate = useNavigate();
  const { teamKey, cycle: c } = props;
  const [editing, setEditing] = useState(false);
  const { draft, setDraft, error, setError } = useDraft(() => draftOf(c));
  const [pending, start] = useTransition();
  const { confirm, dialogs } = useDialogs();
  const past = c.state === "past";

  const save = () =>
    start(async () => {
      try {
        await api.cycles.update(teamKey, c.number, inputOf(draft, { withDates: !past }));
      } catch (e) {
        return setError(describeFailure(e));
      }
      setEditing(false);
      setError(null);
      await refreshAll(queryClient);
    });

  const remove = async () => {
    if (!(await confirm({ title: `Delete ${cycleTitle(c)}?`, description: c.total ? `Its ${c.total} ticket${c.total === 1 ? "" : "s"} stay on the board, in no cycle.` : undefined, confirmLabel: "Delete", danger: true }))) return;
    start(async () => {
      try {
        await api.cycles.delete(teamKey, c.number);
      } catch (e) {
        return setError(describeFailure(e));
      }
      await refreshAll(queryClient);
      navigate(`/t/${teamKey}/cycles`);
    });
  };

  const ticketLink = (ref: string, title: string) => (
    <Link to={`/t/${teamKey}?t=${encodeURIComponent(ref)}`} className="hover:underline">
      <span className="font-mono text-[11px] text-muted">{ref}</span> {title}
    </Link>
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <Link to={`/t/${teamKey}/cycles`} className="text-xs text-muted hover:text-fg">
          ← All cycles
        </Link>
        <div className="mt-2 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold">{cycleTitle(c)}</h2>
              {stateChip(c.state)}
            </div>
            <p className="mt-1 text-sm text-muted">
              {cycleRange(c)} · {cycleTiming(c)}
            </p>
            {c.goal && <p className="mt-2 text-sm">{c.goal}</p>}
            <div className="mt-3">
              <Progress done={c.done} total={c.total} />
            </div>
          </div>
          {!editing && (
            <div className="flex shrink-0 gap-2 text-xs">
              <button className="btn" onClick={() => (setDraft(draftOf(c)), setError(null), setEditing(true))}>
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
            <CycleForm draft={draft} onChange={setDraft} onSubmit={save} onCancel={() => (setEditing(false), setError(null))} submitLabel="Save" pending={pending} error={error} datesLocked={past} />
          </div>
        )}
        {!editing && error && <p className="mt-3 text-sm text-danger" role="alert">{error}</p>}

        <section className="mt-6" aria-label="Tickets in this cycle">
          <h3 className="label mb-2">Tickets in this cycle</h3>
          {c.tickets.length === 0 ? (
            <p className="text-sm text-muted">No tickets yet. Add one from its card on the board, in the Cycle field.</p>
          ) : (
            <ul className="divide-y divide-line rounded-md border border-line bg-panel">
              {c.tickets.map((t) => (
                <li key={t.ref} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className={clsx("flex w-4 justify-center", t.done ? "text-ok" : "text-muted")} role="img" aria-label={t.done ? "done" : "open"}>
                    {t.done ? <CheckIcon /> : <span className="inline-block size-2.5 rounded-full border border-muted" />}
                  </span>
                  <span className={clsx("min-w-0 flex-1 truncate", t.done && "text-muted line-through")}>{ticketLink(t.ref, t.title)}</span>
                  <span className="chip bg-panel-2 text-muted">{t.column}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-6" aria-label="What landed">
          <h3 className="label mb-1">What landed</h3>
          <p className="mb-2 text-xs text-muted">Tickets of this team that reached Done while the cycle ran{c.state === "current" ? " so far" : ""}.</p>
          {c.state === "upcoming" ? (
            <p className="text-sm text-muted">The cycle has not started.</p>
          ) : c.landed.length === 0 ? (
            <p className="text-sm text-muted">Nothing has reached Done in this window.</p>
          ) : (
            <ul className="divide-y divide-line rounded-md border border-line bg-panel">
              {c.landed.map((l) => (
                <li key={l.ref} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="text-ok"><CheckIcon /></span>
                  <span className="min-w-0 flex-1 truncate">{ticketLink(l.ref, l.title)}</span>
                  {!l.inCycle && <span className="chip bg-warn/15 text-warn" title="It was not in this cycle">outside the cycle</span>}
                  <span className="text-xs text-muted">{new Date(l.doneAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      {dialogs}
    </div>
  );
}
