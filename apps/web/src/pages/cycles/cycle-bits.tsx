import { useState } from "react";
import clsx from "clsx";
import type { CycleInput, CycleOption, CycleState, CycleSummary } from "@wheelhouse/api-client";
import { Tip } from "../../components/tip";

const DAY = 86_400_000;

/** "Cycle 3" or "Cycle 3: Spring". */
export const cycleTitle = (c: Pick<CycleOption, "number" | "name">) => (c.name ? `Cycle ${c.number}: ${c.name}` : `Cycle ${c.number}`);

const fmt = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
/** "Oct 20 – Nov 3". The end is the moment the cycle ends, so the last day shown is the one before it. */
export const cycleRange = (c: Pick<CycleOption, "startsAt" | "endsAt">) => `${fmt(c.startsAt)} – ${fmt(new Date(new Date(c.endsAt).getTime() - 1).toISOString())}`;

export const STATE_STYLE: Record<CycleState, string> = {
  current: "bg-ok/15 text-ok",
  upcoming: "bg-accent/15 text-accent",
  past: "bg-muted/15 text-muted",
};

/** How long is left, or how long until it starts, in words. */
export function cycleTiming(c: Pick<CycleOption, "startsAt" | "endsAt" | "state">, now = Date.now()) {
  const days = (ms: number) => Math.max(1, Math.ceil(ms / DAY));
  if (c.state === "current") return `ends in ${days(new Date(c.endsAt).getTime() - now)} day${days(new Date(c.endsAt).getTime() - now) === 1 ? "" : "s"}`;
  if (c.state === "upcoming") return `starts in ${days(new Date(c.startsAt).getTime() - now)} day${days(new Date(c.startsAt).getTime() - now) === 1 ? "" : "s"}`;
  return `ended ${fmt(c.endsAt)}`;
}

/** Done issues as a share of the cycle's issues. */
export function Progress({ done, total, compact = false }: { done: number; total: number; compact?: boolean }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  const text = total ? `${done} of ${total} done` : "no issues yet";
  const bar = (
    <div className="h-1.5 w-28 overflow-hidden rounded-full bg-panel-2">
      <div className="h-full rounded-full bg-ok" style={{ width: `${pct}%` }} />
    </div>
  );
  // `compact` keeps the words out of the row: they are the bar's tooltip.
  if (compact) return <div aria-label={`${done} of ${total} issues done`}><Tip content={text}>{bar}</Tip></div>;
  return (
    <div className="flex items-center gap-2" aria-label={`${done} of ${total} issues done`}>
      {bar}
      <span className="text-xs tabular-nums text-muted">{text}</span>
    </div>
  );
}

export const stateChip = (state: CycleState) => <span className={clsx("chip", STATE_STYLE[state])}>{state}</span>;

// ───────── the form: a name, a goal, a start day and a length ─────────

const toInputDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** A day from the date input as the moment that day begins, here. */
const startOfDay = (value: string) => new Date(`${value}T00:00:00`);

export type CycleDraft = { name: string; goal: string; start: string; days: string };

export const newDraft = (): CycleDraft => ({ name: "", goal: "", start: toInputDate(new Date()), days: "14" });
export const draftOf = (c: CycleSummary): CycleDraft => ({
  name: c.name,
  goal: c.goal,
  start: toInputDate(new Date(c.startsAt)),
  days: String(Math.round((new Date(c.endsAt).getTime() - new Date(c.startsAt).getTime()) / DAY)),
});

/** What the server is asked for: the dates only when they are meant to change. */
export function inputOf(d: CycleDraft, o: { withDates: boolean }): CycleInput {
  const out: CycleInput = { name: d.name.trim(), goal: d.goal.trim() };
  if (o.withDates) {
    const startsAt = startOfDay(d.start);
    out.startsAt = startsAt.toISOString();
    out.endsAt = new Date(startsAt.getTime() + Number(d.days) * DAY).toISOString();
  }
  return out;
}

export function CycleForm(props: {
  draft: CycleDraft;
  onChange: (d: CycleDraft) => void;
  onSubmit: () => void;
  onCancel: () => void;
  submitLabel: string;
  pending: boolean;
  error: string | null;
  /** A cycle that has ended keeps its dates: only the name and the goal can change. */
  datesLocked?: boolean;
}) {
  const { draft, onChange } = props;
  const valid = !!draft.start && Number.isInteger(Number(draft.days)) && Number(draft.days) >= 1 && Number(draft.days) <= 14;
  return (
    <form
      className="space-y-2 rounded-md border border-accent/40 bg-panel p-3"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit();
      }}
    >
      <input className="input" placeholder="Name (optional, e.g. Spring clean-up)" aria-label="Name" value={draft.name} maxLength={60} onChange={(e) => onChange({ ...draft, name: e.target.value })} autoFocus />
      <textarea className="input min-h-16" placeholder="Goal: what should be true when this cycle ends?" aria-label="Goal" value={draft.goal} maxLength={500} onChange={(e) => onChange({ ...draft, goal: e.target.value })} />
      {!props.datesLocked && (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block text-xs text-muted">
            Starts
            <input className="input mt-1" type="date" value={draft.start} onChange={(e) => onChange({ ...draft, start: e.target.value })} />
          </label>
          <label className="block text-xs text-muted">
            Lasts (days, 1 to 14)
            <input className="input mt-1" type="number" min={1} max={14} value={draft.days} onChange={(e) => onChange({ ...draft, days: e.target.value })} />
          </label>
        </div>
      )}
      {props.error && <p className="text-sm text-danger" role="alert">{props.error}</p>}
      <div className="flex gap-2">
        <button type="submit" className="btn btn-primary" disabled={props.pending || (!props.datesLocked && !valid)}>
          {props.submitLabel}
        </button>
        <button type="button" className="btn" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The "new cycle" / "edit" state of a form, with the pending flag and the last error. */
export function useDraft(initial: () => CycleDraft) {
  const [draft, setDraft] = useState<CycleDraft>(initial);
  const [error, setError] = useState<string | null>(null);
  return { draft, setDraft, error, setError };
}
