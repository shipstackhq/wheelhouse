import { useState } from "react";
import clsx from "clsx";
import type { InitiativeInput, InitiativeStatus, InitiativeSummary } from "@wheelhouse/api-client";
import { Select } from "../../components/ui";
import { day } from "../projects/project-bits";

export const INITIATIVE_STATUSES: InitiativeStatus[] = ["planned", "active", "paused", "done"];

const STATUS_STYLE: Record<InitiativeStatus, string> = {
  planned: "bg-panel-2 text-muted",
  active: "bg-accent/15 text-accent",
  paused: "bg-warn/15 text-warn",
  done: "bg-ok/15 text-ok",
};
export const initiativeStatusChip = (s: InitiativeStatus) => <span className={clsx("chip", STATUS_STYLE[s])}>{s}</span>;

export const targetOf = (i: Pick<InitiativeSummary, "targetDate">) => (i.targetDate ? `target ${day(i.targetDate)}` : "no target date");

export type InitiativeDraft = { name: string; description: string; status: InitiativeStatus; targetDate: string; parentId: string };
export const newDraft = (parentId = ""): InitiativeDraft => ({ name: "", description: "", status: "planned", targetDate: "", parentId });
export const draftOf = (i: InitiativeSummary): InitiativeDraft => ({ name: i.name, description: i.description, status: i.status, targetDate: i.targetDate ?? "", parentId: i.parentId ?? "" });

/** What is sent: an empty date is `null` (cleared). The parent is sent only when making one, or when it changed (moving is done from the list). */
export function inputOf(d: InitiativeDraft, o: { create: boolean; version?: number }): InitiativeInput & { name: string } {
  const out: InitiativeInput & { name: string } = { name: d.name.trim(), description: d.description.trim(), status: d.status, targetDate: d.targetDate || null };
  if (o.create) out.parentId = d.parentId || null;
  else out.version = o.version;
  return out;
}

export function InitiativeForm(props: {
  draft: InitiativeDraft;
  onChange: (d: InitiativeDraft) => void;
  onSubmit: () => void;
  onCancel: () => void;
  submitLabel: string;
  pending: boolean;
  error: string | null;
  /** When making one: the initiatives it could go under (those that leave room for one more level). */
  parents?: { id: string; name: string }[];
}) {
  const { draft, onChange, parents } = props;
  const [touched, setTouched] = useState(false);
  const valid = !!draft.name.trim();
  return (
    <form
      className="space-y-2 rounded-md border border-accent/40 bg-panel p-3"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (valid) props.onSubmit();
      }}
    >
      <input className="input" placeholder="Initiative name (e.g. Enterprise ready)" aria-label="Name" value={draft.name} maxLength={120} onChange={(e) => onChange({ ...draft, name: e.target.value })} autoFocus />
      <textarea className="input min-h-20" placeholder="What are we trying to achieve?" aria-label="Description" value={draft.description} onChange={(e) => onChange({ ...draft, description: e.target.value })} />
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-xs text-muted">
          Status
          <Select ariaLabel="Status" value={draft.status} options={INITIATIVE_STATUSES.map((s) => ({ value: s, label: s }))} onValueChange={(v) => onChange({ ...draft, status: v as InitiativeStatus })} />
        </label>
        <label className="block text-xs text-muted">
          Target
          <input className="input mt-1" type="date" aria-label="Target date" value={draft.targetDate} onChange={(e) => onChange({ ...draft, targetDate: e.target.value })} />
        </label>
      </div>
      {parents && parents.length > 0 && (
        <label className="block text-xs text-muted">
          Under
          <Select ariaLabel="Under" value={draft.parentId || "none"} options={[{ value: "none", label: "Nothing (a top initiative)" }, ...parents.map((p) => ({ value: p.id, label: p.name }))]} onValueChange={(v) => onChange({ ...draft, parentId: v === "none" ? "" : v })} />
        </label>
      )}
      {props.error && <p className="text-sm text-danger" role="alert">{props.error}</p>}
      {touched && !valid && !props.error && <p className="text-sm text-danger" role="alert">An initiative needs a name.</p>}
      <div className="flex gap-2">
        <button type="submit" className="btn btn-primary" disabled={props.pending}>
          {props.submitLabel}
        </button>
        <button type="button" className="btn" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
