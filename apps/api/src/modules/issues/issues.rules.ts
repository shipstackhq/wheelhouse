import { DEFAULT_STATUS_DEFS } from "@wheelhouse/shared/status-roles";
import * as schema from "../../db/schema";
import type { InitiativeStatus, ProjectHealth, ProjectStatus } from "../../db/schema";
import { ServiceError } from "../../common/service-error";

/**
 * The module's pure rules and the readers of a request body: no database, nothing injected. The rules of positions, labels, sub-issue
 * depth, cycle windows, project and initiative health and the initiative tree sit here so they are tested alone; the services decide
 * what to do with them.
 */

export const DEFAULT_STATUSES = DEFAULT_STATUS_DEFS.map((c) => c.name);

/** A field error: `invalid`, with the message under the field's name. */
export const bad = (field: string, message: string): never => {
  throw new ServiceError("invalid", message, { fields: { [field]: message } });
};

const DAY = 86_400_000;

// ───────── positions ─────────

/** The position between two neighbours (either may be missing: the first or the last place). */
export function positionBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return 1000;
  if (before === undefined) return after! - 1000;
  if (after === undefined) return before + 1000;
  return (before + after) / 2;
}

/** The position that puts an item at `index` among its siblings in order; an index outside them means the end. */
export function positionAmong(siblings: { position: number }[], index: number | undefined): number {
  const i = index === undefined || index < 0 || index > siblings.length ? siblings.length : index;
  return positionBetween(siblings[i - 1]?.position, siblings[i]?.position);
}

// ───────── issues ─────────

export type IssueInput = {
  title?: string;
  body?: string;
  priority?: (typeof schema.PRIORITIES)[number];
  assigneeId?: string | null;
  agentClaimable?: boolean;
  labels?: string[];
  /** The number of one of the issue's own team's cycles that has not ended; null takes it out of its cycle. */
  cycle?: number | null;
  /**
   * The id of a project the issue's team takes part in; null takes the issue out of its project (and its milestone). Named
   * `projectId`, not `project`: the tools pass their own `project` argument (the team) through this same object.
   */
  projectId?: string | null;
  /** The id of a milestone of the issue's project; null clears it. Changing the project clears it unless a new one is named. */
  milestoneId?: string | null;
  /** The issue this one is a sub-issue of: a ref ("WH-12") or id of an issue in the same team; null makes it a top-level issue. */
  parent?: string | null;
  /** WH-113: the slug of an agent on the team's roster to delegate to, or null to clear. Only the assignee or an admin. */
  delegate?: string | null;
};

/** Agent claims with no activity from the claiming agent for this long are released. */
export const CLAIM_TTL_MS = 24 * 3600e3;

/** Labels are stored once per name in any case and read back alphabetically, so a different order or case is no change. */
export function sameLabels(a: string[], b: string[]): boolean {
  const key = (xs: string[]) => xs.map((x) => x.toLowerCase()).sort().join("\u0000");
  return key(a) === key(b);
}

/** A ref like "WH-12": the team key and the number, or null when it is not one. */
export function parseIssueRef(ref: string): { key: string; number: number } | null {
  const m = /^([A-Za-z]+)-(\d+)$/.exec(ref.trim());
  return m ? { key: m[1], number: Number(m[2]) } : null;
}

/**
 * Sub-issues: an issue can sit under another issue of its own team, as deep as MAX_ISSUE_DEPTH levels (a guard against a runaway
 * chain, not a product limit anyone should meet).
 */
export const MAX_ISSUE_DEPTH = 50;

/** `above` levels from the parent up to the top, `below` levels from the child down: do they fit together? */
export const fitsDepth = (above: number, below: number) => above + below <= MAX_ISSUE_DEPTH;

// ───────── reading a request body ─────────

/** A whole number from a JSON body, or undefined when absent. Anything else (a string, 1.5, NaN) is a field error. */
export function intField(b: Record<string, unknown>, name: string): number | undefined {
  const v = b[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isSafeInteger(v)) return bad(name, `${name} must be a whole number`);
  return v;
}

/**
 * The issue fields a request may carry, checked the way the MCP tools check them (a string, a known priority, a list of strings,
 * true or false) so a wrong type is a 400 naming the field and never reaches the database. For a new issue the title is required.
 */
export function issueInput(b: Record<string, unknown>, o: { create: boolean }): IssueInput {
  const out: IssueInput = {};
  if (b.title !== undefined) {
    if (typeof b.title !== "string") bad("title", "title must be text");
    out.title = (b.title as string).trim();
    if (!out.title) bad("title", "title is required");
  } else if (o.create) bad("title", "title is required");
  if (b.body !== undefined) {
    if (typeof b.body !== "string") bad("body", "body must be text");
    out.body = b.body as string;
  }
  if (b.priority !== undefined) {
    if (typeof b.priority !== "string" || !(schema.PRIORITIES as readonly string[]).includes(b.priority)) bad("priority", `priority must be one of ${schema.PRIORITIES.join(", ")}`);
    out.priority = b.priority as (typeof schema.PRIORITIES)[number];
  }
  if (b.assigneeId !== undefined) {
    if (b.assigneeId !== null && typeof b.assigneeId !== "string") bad("assigneeId", "assigneeId must be a person's id, or null for nobody");
    out.assigneeId = (b.assigneeId as string | null) || null;
  }
  if (b.agentClaimable !== undefined) {
    if (typeof b.agentClaimable !== "boolean") bad("agentClaimable", "agentClaimable must be true or false");
    out.agentClaimable = b.agentClaimable as boolean;
  }
  if (b.labels !== undefined) {
    if (!Array.isArray(b.labels) || b.labels.some((l) => typeof l !== "string")) bad("labels", "labels must be a list of text");
    out.labels = b.labels as string[];
  }
  for (const f of ["projectId", "milestoneId"] as const) {
    if (b[f] !== undefined) {
      if (b[f] !== null && typeof b[f] !== "string") bad(f, `${f} must be an id, or null for none`);
      out[f] = (b[f] as string | null) || null;
    }
  }
  if (b.parent !== undefined) {
    if (b.parent !== null && (typeof b.parent !== "string" || !b.parent.trim())) bad("parent", "parent must be an issue ref like WH-12, or null for none");
    out.parent = b.parent === null ? null : (b.parent as string).trim();
  }
  if (b.delegate !== undefined) {
    if (b.delegate !== null && (typeof b.delegate !== "string" || !b.delegate.trim())) bad("delegate", "delegate must be an agent's slug, or null for none");
    out.delegate = b.delegate === null ? null : (b.delegate as string).trim();
  }
  if (b.cycle !== undefined) {
    if (b.cycle !== null && (typeof b.cycle !== "number" || !Number.isSafeInteger(b.cycle))) bad("cycle", "cycle must be a cycle number, or null for none");
    out.cycle = b.cycle as number | null;
  }
  return out;
}

/** The status of a move or a new issue: an id, a name or a role ("review"); the service finds it in this issue's own team. */
export function statusField(b: Record<string, unknown>, required: boolean): string | undefined {
  const v = b.status;
  if (v === undefined || v === null) return required ? bad("status", "status is required") : undefined;
  if (typeof v !== "string" || !v.trim()) return bad("status", "status must be text");
  return v;
}

// ───────── cycles ─────────

type Window = { startsAt: Date; endsAt: Date };
export type CycleState = "upcoming" | "current" | "past";

export const CYCLE_MIN_MS = DAY;
export const CYCLE_MAX_MS = 14 * DAY;

export const stateOf = (c: Window, now: Date): CycleState => (c.endsAt.getTime() <= now.getTime() ? "past" : c.startsAt.getTime() <= now.getTime() ? "current" : "upcoming");

export const cycleLabel = (c: { number: number; name: string }) => (c.name ? `Cycle ${c.number}: ${c.name}` : `Cycle ${c.number}`);

export function toDate(v: unknown, field: string): Date {
  const d = v instanceof Date ? v : typeof v === "string" || typeof v === "number" ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) return bad(field, `${field} must be a date and time`);
  return d;
}

export function checkWindow(startsAt: Date, endsAt: Date) {
  if (endsAt.getTime() <= startsAt.getTime()) bad("endsAt", "A cycle must end after it starts");
  const len = endsAt.getTime() - startsAt.getTime();
  if (len < CYCLE_MIN_MS) bad("endsAt", "A cycle lasts at least one day");
  if (len > CYCLE_MAX_MS) bad("endsAt", "A cycle lasts at most two weeks");
}

/** Optional text of at most `max` characters, trimmed; undefined when absent. */
export const cleanText = (s: unknown, field: string, max: number) => {
  if (s === undefined) return undefined;
  if (typeof s !== "string") return bad(field, `${field} must be text`);
  const t = s.trim();
  if (t.length > max) return bad(field, `${field} is at most ${max} characters`);
  return t;
};

/** Where the next cycle starts when the team was away: where this one ended, moved on by whole lengths so it holds `now`. */
export function nextWindow(c: Window, now: Date): Window {
  const len = c.endsAt.getTime() - c.startsAt.getTime();
  const skip = Math.max(0, Math.floor((now.getTime() - c.endsAt.getTime()) / len));
  const startsAt = new Date(c.endsAt.getTime() + skip * len);
  return { startsAt, endsAt: new Date(startsAt.getTime() + len) };
}

// ───────── health, derived ─────────

export type ProgressCounts = { total: number; done: number };
export type HealthView = { derived: ProjectHealth | null; override: ProjectHealth | null; value: ProjectHealth | null };

const dayStart = (d: string) => Date.parse(`${d}T00:00:00.000Z`);

/**
 * How a project is going, from its issues and dates. Only an active project has a health; the one the people set (the override)
 * wins over it. Past its target date with work still open is off track; otherwise the share of time gone is compared with the
 * share of issues done (a gap over a quarter is at risk, over a half is off track). A project with no dates and no issues has
 * nothing to judge.
 */
export function deriveHealth(p: { status: ProjectStatus; startDate: string | null; targetDate: string | null }, progress: ProgressCounts, now: Date): ProjectHealth | null {
  if (p.status !== "active") return null;
  const open = progress.total - progress.done;
  const finished = progress.total > 0 && open === 0;
  const end = p.targetDate ? dayStart(p.targetDate) + DAY : null; // the target day counts as a working day
  if (end !== null && now.getTime() >= end && !finished) return "off_track";
  if (finished) return "on_track";
  if (progress.total === 0) return null;
  const doneShare = progress.done / progress.total;
  if (end !== null) {
    const start = p.startDate ? dayStart(p.startDate) : null;
    if (start !== null && end > start) {
      const gap = Math.min(1, Math.max(0, (now.getTime() - start) / (end - start))) - doneShare;
      return gap > 0.5 ? "off_track" : gap > 0.25 ? "at_risk" : "on_track";
    }
    // Only an end: close and less than half done is at risk.
    return (end - now.getTime()) / DAY <= 3 && doneShare < 0.5 ? "at_risk" : "on_track";
  }
  return "on_track";
}

export const healthOf = (p: { status: ProjectStatus; startDate: string | null; targetDate: string | null; healthOverride: ProjectHealth | null }, progress: ProgressCounts, now: Date): HealthView => {
  const derived = deriveHealth(p, progress, now);
  return { derived, override: p.healthOverride ?? null, value: p.healthOverride ?? derived };
};

/** How an initiative is going: only an active one has a health, and one set by hand wins. The same reading as a project, from its target date. */
export function initiativeHealth(i: { status: InitiativeStatus; targetDate: string | null; healthOverride: ProjectHealth | null }, progress: ProgressCounts, now: Date): HealthView {
  const derived = deriveHealth({ status: i.status === "active" ? "active" : "planned", startDate: null, targetDate: i.targetDate }, progress, now);
  return { derived, override: i.healthOverride ?? null, value: i.healthOverride ?? derived };
}

export const STATUS_ORDER: Record<ProjectStatus, number> = { active: 0, planned: 1, paused: 2, completed: 3, canceled: 4 };

export const sumProgress = (ids: string[], progress: Map<string, ProgressCounts>): ProgressCounts =>
  ids.reduce((acc, p) => ({ total: acc.total + (progress.get(p)?.total ?? 0), done: acc.done + (progress.get(p)?.done ?? 0) }), { total: 0, done: 0 });

// ───────── reading a project's or initiative's request body ─────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function text(v: unknown, field: string, max: number, required = false): string | undefined {
  if (v === undefined) return required ? bad(field, `${field} is required`) : undefined;
  if (typeof v !== "string") return bad(field, `${field} must be text`);
  const t = v.trim();
  if (required && !t) return bad(field, `${field} is required`);
  if (t.length > max) return bad(field, `${field} is at most ${max} characters`);
  return t;
}

export function day(v: unknown, field: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v !== "string" || !DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) return bad(field, `${field} must be a date like 2026-12-31`);
  return v;
}

export function oneOf<T extends string>(v: unknown, list: readonly T[], field: string): T | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !(list as readonly string[]).includes(v)) return bad(field, `${field} must be one of ${list.join(", ")}`);
  return v as T;
}

export type ProjectInput = {
  name?: unknown;
  description?: unknown;
  status?: unknown;
  priority?: unknown;
  startDate?: unknown;
  targetDate?: unknown;
  /** The person who leads it (a member of the workspace, not a guest); null for nobody. */
  leadUser?: unknown;
  /** The key of the lead team: one of the teams taking part. */
  leadTeam?: unknown;
  /** `null` clears the health that was set by hand. */
  healthOverride?: unknown;
  /** When creating: the keys of the other teams taking part. */
  teams?: unknown;
  /** The version last read, for an update. */
  version?: unknown;
};

export type MilestoneInput = { name?: unknown; description?: unknown; targetDate?: unknown; index?: unknown };

export type InitiativeInput = {
  name?: unknown;
  description?: unknown;
  status?: unknown;
  targetDate?: unknown;
  /** A member of the workspace (not a guest); null for nobody. */
  owner?: unknown;
  /** The initiative it sits under; null for a top one. */
  parentId?: unknown;
  /** `null` clears the health that was set by hand. */
  healthOverride?: unknown;
  /** Its place among its siblings, from 0. */
  index?: unknown;
  /** The version last read, for an update. */
  version?: unknown;
};

export type CycleInput = { name?: string; goal?: string; startsAt?: unknown; endsAt?: unknown };

/** The cycle fields a request may carry; the service judges the values. */
export const cycleInput = (b: Record<string, unknown>): CycleInput => ({ name: b.name as string | undefined, goal: b.goal as string | undefined, startsAt: b.startsAt, endsAt: b.endsAt });

// ───────── the initiative tree ─────────

type TreeRow = { id: string; parentId: string | null; position: number; createdAt: Date };
export type Tree<R extends TreeRow = TreeRow> = { byId: Map<string, R>; kids: Map<string | null, R[]> };

export function treeOf<R extends TreeRow>(rows: R[]): Tree<R> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const kids = new Map<string | null, R[]>();
  for (const r of rows) {
    const k = r.parentId && byId.has(r.parentId) ? r.parentId : null;
    kids.set(k, [...(kids.get(k) ?? []), r]);
  }
  for (const list of kids.values()) list.sort((a, b) => a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime());
  return { byId, kids };
}

/** The initiative and everything under it. */
export function subtree<R extends TreeRow>(t: Tree<R>, id: string): R[] {
  const out: R[] = [];
  const walk = (i: string) => {
    const row = t.byId.get(i);
    if (!row) return;
    out.push(row);
    for (const c of t.kids.get(i) ?? []) walk(c.id);
  };
  walk(id);
  return out;
}

/** How many levels the initiative sits at (1 for a top one). */
export function depthOf<R extends TreeRow>(t: Tree<R>, id: string): number {
  let d = 1;
  for (let cur = t.byId.get(id); cur?.parentId && t.byId.has(cur.parentId); cur = t.byId.get(cur.parentId)) d++;
  return d;
}

/** How many levels the initiative and its sub-initiatives take (1 for one with none under it). */
function heightOf<R extends TreeRow>(t: Tree<R>, id: string): number {
  return 1 + Math.max(0, ...(t.kids.get(id) ?? []).map((c) => heightOf(t, c.id)));
}

/**
 * Can `id` sit under `parentId` (null for the top)? Not under itself or anything below it, and not so deep that it or what is under
 * it goes past three levels.
 */
export function checkParent<R extends TreeRow>(t: Tree<R>, id: string | null, parentId: string | null) {
  if (parentId === null) return;
  if (!t.byId.has(parentId)) bad("parentId", "That parent initiative does not exist");
  if (id !== null && subtree(t, id).some((r) => r.id === parentId)) bad("parentId", "An initiative cannot sit under itself or under one of its own sub-initiatives");
  const below = id === null ? 1 : heightOf(t, id);
  if (depthOf(t, parentId) + below > schema.INITIATIVE_MAX_DEPTH) bad("parentId", `Initiatives nest at most ${schema.INITIATIVE_MAX_DEPTH} levels deep`);
}

/**
 * The projects an initiative reaches: its own links and those of every initiative under it, each project once. An issue is in one
 * project, so summing over this set counts an issue once however many links lead to its project.
 */
export function reachableProjects<R extends TreeRow>(t: Tree<R>, linked: Map<string, string[]>, id: string): string[] {
  return [...new Set(subtree(t, id).flatMap((i) => linked.get(i.id) ?? []))];
}
