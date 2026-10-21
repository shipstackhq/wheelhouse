import type { BoardIssue, BoardMember, BoardStatus, CycleOption, TeamProjectOption } from "@wheelhouse/api-client";
import { PRIORITY_LABEL, PRIORITY_ORDER } from "../components/priority-icon";

/**
 * What a team's issues are narrowed to, grouped by and ordered by: one view, shared by the list and the board, remembered in this browser
 * per team. All of it is pure (no React), so the rules can be tested without a screen.
 */

export const GROUP_BYS = ["status", "priority", "assignee", "project", "cycle", "none"] as const;
export type GroupBy = (typeof GROUP_BYS)[number];
export const GROUP_LABEL: Record<GroupBy, string> = { status: "Status", priority: "Priority", assignee: "Assignee", project: "Project", cycle: "Cycle", none: "No grouping" };

export const SORT_KEYS = ["manual", "priority", "updated", "created", "title", "number"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export const SORT_LABEL: Record<SortKey, string> = { manual: "Manual", priority: "Priority", updated: "Last updated", created: "Created", title: "Title", number: "Number" };

/** The filters: each lists what to keep (nothing listed keeps everything). "none" in assignee, project and cycle keeps the issues with no value. */
export type Filters = { status: string[]; priority: string[]; assignee: string[]; label: string[]; project: string[]; cycle: string[] };
export const FILTER_KEYS = ["status", "priority", "assignee", "label", "project", "cycle"] as const satisfies readonly (keyof Filters)[];
export type FilterKey = (typeof FILTER_KEYS)[number];

export type IssueView = { groupBy: GroupBy; filters: Filters; sort: { key: SortKey; dir: "asc" | "desc" }; search: string };

export const EMPTY_FILTERS: Filters = { status: [], priority: [], assignee: [], label: [], project: [], cycle: [] };
export const DEFAULT_VIEW: IssueView = { groupBy: "status", filters: EMPTY_FILTERS, sort: { key: "manual", dir: "asc" }, search: "" };

export const isFiltered = (v: IssueView) => v.search.trim() !== "" || FILTER_KEYS.some((k) => v.filters[k].length > 0);
export const filterCount = (v: IssueView) => FILTER_KEYS.reduce((n, k) => n + v.filters[k].length, 0);

// ───────── remembered per team ─────────

const key = (teamKey: string) => `wh:issue-view:${teamKey}`;
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** A stored value read back as a view: anything unknown or damaged is replaced by the default for that part, so an old or edited value never breaks the page. */
export function parseView(raw: unknown): IssueView {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const f = o.filters && typeof o.filters === "object" ? (o.filters as Record<string, unknown>) : {};
  const s = o.sort && typeof o.sort === "object" ? (o.sort as Record<string, unknown>) : {};
  return {
    groupBy: (GROUP_BYS as readonly unknown[]).includes(o.groupBy) ? (o.groupBy as GroupBy) : DEFAULT_VIEW.groupBy,
    filters: Object.fromEntries(FILTER_KEYS.map((k) => [k, strings(f[k])])) as Filters,
    sort: { key: (SORT_KEYS as readonly unknown[]).includes(s.key) ? (s.key as SortKey) : "manual", dir: s.dir === "desc" ? "desc" : "asc" },
    search: typeof o.search === "string" ? o.search : "",
  };
}

export function loadIssueView(teamKey: string): IssueView {
  try {
    return parseView(JSON.parse(localStorage.getItem(key(teamKey)) ?? "null"));
  } catch {
    return DEFAULT_VIEW;
  }
}

export function saveIssueView(teamKey: string, view: IssueView) {
  try {
    // Search is what you are looking for right now, not a preference: it is not kept.
    localStorage.setItem(key(teamKey), JSON.stringify({ ...view, search: "" }));
  } catch {
    /* no storage: it lasts until the page is closed */
  }
}

// ───────── filtering ─────────

/** Every word typed must be found in the ref, the title or a label (any case), so "login bug" finds an issue titled "Bug in login". */
export function matchesSearch(t: Pick<BoardIssue, "ref" | "title" | "labels">, search: string): boolean {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = [t.ref, t.title, ...t.labels].join("\n").toLowerCase();
  return words.every((w) => haystack.includes(w));
}

const keeps = (wanted: string[], value: string | null) => wanted.length === 0 || wanted.includes(value ?? "none");

export function matchesView(t: BoardIssue, v: IssueView): boolean {
  const f = v.filters;
  return (
    matchesSearch(t, v.search) &&
    keeps(f.status, t.statusId) &&
    keeps(f.priority, t.priority) &&
    keeps(f.assignee, t.assigneeId) &&
    keeps(f.project, t.projectId) &&
    keeps(f.cycle, t.cycle == null ? null : String(t.cycle)) &&
    (f.label.length === 0 || t.labels.some((l) => f.label.includes(l)))
  );
}

export const filterIssues = (issues: BoardIssue[], v: IssueView) => (isFiltered(v) ? issues.filter((t) => matchesView(t, v)) : issues);

// ───────── ordering ─────────

const prank = (p: string) => PRIORITY_ORDER.indexOf(p as (typeof PRIORITY_ORDER)[number]);

/** The issues in the order asked for (a copy). Manual is the board order. Ties fall back to the board order so the result never jumps about. */
export function sortIssues(issues: BoardIssue[], sort: IssueView["sort"]): BoardIssue[] {
  const sign = sort.dir === "desc" ? -1 : 1;
  const cmp: Record<SortKey, (a: BoardIssue, b: BoardIssue) => number> = {
    manual: (a, b) => a.position - b.position,
    // "Most pressing first" is ascending: urgent, high, medium, low, then no priority.
    priority: (a, b) => prank(a.priority) - prank(b.priority),
    updated: (a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt),
    created: (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
    title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
    number: (a, b) => a.number - b.number,
  };
  const d = sort.key === "manual" ? 1 : sign;
  return [...issues].sort((a, b) => d * cmp[sort.key](a, b) || a.position - b.position || a.number - b.number);
}

// ───────── grouping ─────────

/** What a group stands for, so a row can offer to change it and a new issue made in the group can start with it. */
export type GroupKind =
  | { kind: "status"; status: BoardStatus }
  | { kind: "priority"; priority: BoardIssue["priority"] }
  | { kind: "assignee"; member: BoardMember | null }
  | { kind: "project"; project: TeamProjectOption | null }
  | { kind: "cycle"; cycle: CycleOption | null }
  | { kind: "none" };

export type IssueGroup = { id: string; label: string; what: GroupKind; issues: BoardIssue[] };

const cycleName = (c: CycleOption) => (c.name ? `Cycle ${c.number}: ${c.name}` : `Cycle ${c.number}`);

export type GroupContext = { statuses: BoardStatus[]; members: BoardMember[]; projects: TeamProjectOption[]; cycles: CycleOption[] };

/**
 * The issues in groups, each in the view's order. Statuses are the workflow, so every status has its group even with nothing in it
 * (to add into), unless something is filtered, when empty groups are only noise. Every other grouping shows the groups that have issues;
 * the group for "none of this" (no assignee, no project, no cycle) comes last.
 */
export function groupIssues(issues: BoardIssue[], view: IssueView, ctx: GroupContext): IssueGroup[] {
  const ordered = sortIssues(issues, view.sort);
  const make = (id: string, label: string, what: GroupKind, pick: (t: BoardIssue) => boolean): IssueGroup => ({ id: `${view.groupBy}:${id}`, label, what, issues: ordered.filter(pick) });
  let groups: IssueGroup[];
  let keepEmpty = false;
  switch (view.groupBy) {
    case "status":
      keepEmpty = !isFiltered(view);
      groups = ctx.statuses.map((s) => make(s.id, s.name, { kind: "status", status: s }, (t) => t.statusId === s.id));
      break;
    case "priority":
      groups = PRIORITY_ORDER.map((p) => make(p, PRIORITY_LABEL[p], { kind: "priority", priority: p }, (t) => t.priority === p));
      break;
    case "assignee":
      groups = [
        ...[...ctx.members].sort((a, b) => a.name.localeCompare(b.name)).map((m) => make(m.id, m.name, { kind: "assignee", member: m }, (t) => t.assigneeId === m.id)),
        make("none", "Unassigned", { kind: "assignee", member: null }, (t) => !t.assigneeId),
      ];
      break;
    case "project":
      groups = [
        ...[...ctx.projects].sort((a, b) => a.name.localeCompare(b.name)).map((p) => make(p.id, p.name, { kind: "project", project: p }, (t) => t.projectId === p.id)),
        make("none", "No project", { kind: "project", project: null }, (t) => !t.projectId),
      ];
      break;
    case "cycle":
      groups = [
        ...ctx.cycles.map((c) => make(String(c.number), cycleName(c), { kind: "cycle", cycle: c }, (t) => t.cycle === c.number)),
        make("none", "No cycle", { kind: "cycle", cycle: null }, (t) => t.cycle == null),
      ];
      break;
    case "none":
      groups = [{ id: "none:all", label: "All issues", what: { kind: "none" }, issues: ordered }];
      keepEmpty = true;
      break;
  }
  return keepEmpty ? groups : groups.filter((g) => g.issues.length > 0);
}

/** The fields a new issue made in this group should start with, so it lands where the person is looking. */
export function startingFields(what: GroupKind): { status?: string; priority?: BoardIssue["priority"]; assigneeId?: string | null; projectId?: string | null; cycle?: number | null } {
  switch (what.kind) {
    case "status": return { status: what.status.id };
    case "priority": return { priority: what.priority };
    case "assignee": return what.member ? { assigneeId: what.member.id } : {};
    case "project": return what.project ? { projectId: what.project.id } : {};
    case "cycle": return what.cycle ? { cycle: what.cycle.number } : {};
    case "none": return {};
  }
}

// ───────── what each filter offers ─────────

export type FilterOption = { value: string; label: string };
export const FILTER_LABEL: Record<FilterKey, string> = { status: "Status", priority: "Priority", assignee: "Assignee", label: "Label", project: "Project", cycle: "Cycle" };

/** The values a filter can keep, in the order a menu lists them, with the "none of these" value last where there is one. */
export function filterOptions(key: FilterKey, ctx: GroupContext & { labels: string[] }): FilterOption[] {
  switch (key) {
    case "status": return ctx.statuses.map((s) => ({ value: s.id, label: s.name }));
    case "priority": return PRIORITY_ORDER.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }));
    case "assignee": return [...[...ctx.members].sort((a, b) => a.name.localeCompare(b.name)).map((m) => ({ value: m.id, label: m.name })), { value: "none", label: "Unassigned" }];
    case "label": return ctx.labels.map((l) => ({ value: l, label: l }));
    case "project": return [...[...ctx.projects].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ value: p.id, label: p.name })), { value: "none", label: "No project" }];
    case "cycle": return [...ctx.cycles.map((c) => ({ value: String(c.number), label: cycleName(c) })), { value: "none", label: "No cycle" }];
  }
}
