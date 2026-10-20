import { useState } from "react";
import clsx from "clsx";
import type { ProjectHealth, ProjectHealthValue, ProjectInput, ProjectStatus, ProjectSummary, Team } from "@wheelhouse/api-client";
import { Select } from "../../components/ui";

export const STATUSES: ProjectStatus[] = ["planned", "active", "paused", "completed", "canceled"];
export const HEALTHS: ProjectHealthValue[] = ["on_track", "at_risk", "off_track"];

export const STATUS_STYLE: Record<ProjectStatus, string> = {
  planned: "bg-panel-2 text-muted",
  active: "bg-accent/15 text-accent",
  paused: "bg-warn/15 text-warn",
  completed: "bg-ok/15 text-ok",
  canceled: "bg-muted/15 text-muted line-through",
};
export const HEALTH_STYLE: Record<ProjectHealthValue, string> = { on_track: "bg-ok/15 text-ok", at_risk: "bg-warn/15 text-warn", off_track: "bg-danger/15 text-danger" };
export const healthLabel = (h: ProjectHealthValue) => ({ on_track: "On track", at_risk: "At risk", off_track: "Off track" })[h];

export const statusChip = (s: ProjectStatus) => <span className={clsx("chip", STATUS_STYLE[s])}>{s}</span>;

/** The health to show, and a note when someone set it by hand. Nothing for a project with no health. */
export function HealthChip({ health }: { health: ProjectHealth }) {
  if (!health.value) return null;
  return (
    <span className={clsx("chip", HEALTH_STYLE[health.value])} title={health.override ? "Set by hand" : "Worked out from the issues and dates"}>
      {healthLabel(health.value)}
      {health.override && <span className="opacity-70"> (set)</span>}
    </span>
  );
}

const fmt = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
export const dateRange = (p: Pick<ProjectSummary, "startDate" | "targetDate">) =>
  p.startDate && p.targetDate ? `${fmt(p.startDate)} – ${fmt(p.targetDate)}` : p.targetDate ? `target ${fmt(p.targetDate)}` : p.startDate ? `from ${fmt(p.startDate)}` : "no dates";
export const day = fmt;

// ───────── the form ─────────

export type ProjectDraft = { name: string; description: string; status: ProjectStatus; startDate: string; targetDate: string; leadTeam: string; teams: string[] };
export const newDraft = (leadTeam = ""): ProjectDraft => ({ name: "", description: "", status: "planned", startDate: "", targetDate: "", leadTeam, teams: [] });
export const draftOf = (p: ProjectSummary): ProjectDraft => ({ name: p.name, description: p.description, status: p.status, startDate: p.startDate ?? "", targetDate: p.targetDate ?? "", leadTeam: p.leadTeam?.key ?? "", teams: [] });

/** What is sent: empty dates are `null` (cleared), and the teams and lead team only for a new project. */
export function inputOf(d: ProjectDraft, o: { create: boolean; version?: number }): ProjectInput & { name: string; leadTeam: string } {
  const out: ProjectInput & { name: string; leadTeam: string } = { name: d.name.trim(), description: d.description.trim(), status: d.status, startDate: d.startDate || null, targetDate: d.targetDate || null, leadTeam: d.leadTeam };
  if (o.create) out.teams = d.teams.filter((k) => k !== d.leadTeam);
  else {
    delete (out as Partial<typeof out>).leadTeam;
    out.version = o.version;
  }
  return out as ProjectInput & { name: string; leadTeam: string };
}

export function ProjectForm(props: {
  draft: ProjectDraft;
  onChange: (d: ProjectDraft) => void;
  onSubmit: () => void;
  onCancel: () => void;
  submitLabel: string;
  pending: boolean;
  error: string | null;
  /** When making a project: the teams the person can edit, to lead it and to bring in. */
  teams?: Team[];
}) {
  const { draft, onChange, teams } = props;
  const [touched, setTouched] = useState(false);
  const datesOk = !draft.startDate || !draft.targetDate || draft.targetDate >= draft.startDate;
  const valid = !!draft.name.trim() && (!teams || !!draft.leadTeam) && datesOk;
  return (
    <form
      className="space-y-2 rounded-md border border-accent/40 bg-panel p-3"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (valid) props.onSubmit();
      }}
    >
      <input className="input" placeholder="Project name (e.g. Launch SSO)" aria-label="Name" value={draft.name} maxLength={120} onChange={(e) => onChange({ ...draft, name: e.target.value })} autoFocus />
      <textarea className="input min-h-20" placeholder="What is this project for, and what does done look like?" aria-label="Description" value={draft.description} onChange={(e) => onChange({ ...draft, description: e.target.value })} />
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="block text-xs text-muted">
          Status
          <Select ariaLabel="Status" value={draft.status} options={STATUSES.map((s) => ({ value: s, label: s }))} onValueChange={(v) => onChange({ ...draft, status: v as ProjectStatus })} />
        </label>
        <label className="block text-xs text-muted">
          Starts
          <input className="input mt-1" type="date" aria-label="Start date" value={draft.startDate} onChange={(e) => onChange({ ...draft, startDate: e.target.value })} />
        </label>
        <label className="block text-xs text-muted">
          Target
          <input className="input mt-1" type="date" aria-label="Target date" value={draft.targetDate} onChange={(e) => onChange({ ...draft, targetDate: e.target.value })} />
        </label>
      </div>
      {!datesOk && <p className="text-sm text-danger" role="alert">The target date is before the start date.</p>}
      {teams && (
        <>
          <label className="block text-xs text-muted">
            Lead team
            <Select ariaLabel="Lead team" value={draft.leadTeam} placeholder="Choose the lead team" options={teams.map((t) => ({ value: t.key, label: `${t.name} (${t.key})` }))} onValueChange={(v) => onChange({ ...draft, leadTeam: v })} />
          </label>
          {teams.length > 1 && (
            <fieldset className="text-sm">
              <legend className="text-xs text-muted">Other teams taking part</legend>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                {teams
                  .filter((t) => t.key !== draft.leadTeam)
                  .map((t) => (
                    <label key={t.key} className="flex items-center gap-1.5">
                      <input type="checkbox" checked={draft.teams.includes(t.key)} onChange={() => onChange({ ...draft, teams: draft.teams.includes(t.key) ? draft.teams.filter((k) => k !== t.key) : [...draft.teams, t.key] })} />
                      {t.name}
                    </label>
                  ))}
              </div>
            </fieldset>
          )}
          {teams.length === 0 && <p className="text-sm text-muted">A project needs a lead team you can edit. You are not on one yet.</p>}
        </>
      )}
      {props.error && <p className="text-sm text-danger" role="alert">{props.error}</p>}
      {touched && !valid && !props.error && datesOk && <p className="text-sm text-danger" role="alert">A project needs a name{teams ? " and a lead team" : ""}.</p>}
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
