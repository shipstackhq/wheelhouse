import type { BoardIssue } from "@wheelhouse/api-client";

/**
 * Sub-issues on screen, without React: how many of an issue's sub-issues are done, which issues cannot be offered as its parent, and how
 * a group of the list lays its issues out (a sub-issue under its parent, indented, when the parent is in the same group).
 */

/** Done out of all, not counting canceled ones: work that was dropped is neither done nor still to do. */
export type Progress = { done: number; total: number };

/** The sub-issues of each issue, by the parent's id, in the order the issues are given. */
export function childrenIndex(all: BoardIssue[]): Map<string, BoardIssue[]> {
  const m = new Map<string, BoardIssue[]>();
  for (const t of all) if (t.parentId) m.set(t.parentId, [...(m.get(t.parentId) ?? []), t]);
  return m;
}

/** An issue's progress over its own sub-issues, or null when it has none. `roleOf` says what a status is (done, canceled, ...). */
export function progressOf(id: string, index: Map<string, BoardIssue[]>, roleOf: (statusId: string) => string | null): Progress | null {
  const kids = index.get(id);
  if (!kids?.length) return null;
  let done = 0;
  let total = 0;
  for (const k of kids) {
    const role = roleOf(k.statusId);
    if (role === "canceled") continue;
    total++;
    if (role === "done") done++;
  }
  return { done, total };
}

/** Every issue below this one, at any depth. The visited set stops a loop in bad data from running forever. */
export function descendantIds(all: BoardIssue[], id: string): Set<string> {
  const index = childrenIndex(all);
  const out = new Set<string>();
  const walk = (parent: string) => {
    for (const k of index.get(parent) ?? []) {
      if (out.has(k.id)) continue;
      out.add(k.id);
      walk(k.id);
    }
  };
  walk(id);
  return out;
}

/** The issues that may become this one's parent: anything but itself and what is below it (that would be a loop). */
export function parentCandidates(all: BoardIssue[], id: string): BoardIssue[] {
  const below = descendantIds(all, id);
  return all.filter((t) => t.id !== id && !below.has(t.id));
}

export type ListRow = {
  issue: BoardIssue;
  depth: number;
  /** Its sub-issues' progress (all of them, wherever they are shown), or null. */
  progress: Progress | null;
  /** How many of its sub-issues are in this group, so the row can fold them away. */
  childrenHere: number;
  /** The ref of its parent when the row is not directly under it (the parent is in another group, filtered out, or nesting is off). */
  parentRef: string | null;
};

export type ArrangeOptions = {
  /** False hides sub-issues from the list altogether (their parents still show their progress). */
  showSub: boolean;
  /** True puts a sub-issue under its parent, indented, when both are in the group. */
  nest: boolean;
  /** Parents whose sub-issues are folded away. */
  folded: Set<string>;
};

/**
 * One group's rows, in the order given, with each sub-issue under its parent (and its own sub-issues under it, as deep as they go) when
 * `nest` is on and the parent is in the same group. A sub-issue whose parent is elsewhere keeps its own place and says whose it is.
 */
export function arrangeRows(list: BoardIssue[], all: BoardIssue[], opts: ArrangeOptions, roleOf: (statusId: string) => string | null): ListRow[] {
  const index = childrenIndex(all);
  const byId = new Map(all.map((t) => [t.id, t]));
  const parentRef = (t: BoardIssue) => (t.parentId ? (byId.get(t.parentId)?.ref ?? null) : null);
  const row = (t: BoardIssue, depth: number, here: number, withParentRef: boolean): ListRow => ({
    issue: t,
    depth,
    progress: progressOf(t.id, index, roleOf),
    childrenHere: here,
    parentRef: withParentRef ? parentRef(t) : null,
  });

  if (!opts.showSub) return list.filter((t) => !t.parentId).map((t) => row(t, 0, 0, false));
  if (!opts.nest) return list.map((t) => row(t, 0, 0, true));

  const inList = new Set(list.map((t) => t.id));
  const here = new Map<string, BoardIssue[]>();
  for (const t of list) if (t.parentId && inList.has(t.parentId)) here.set(t.parentId, [...(here.get(t.parentId) ?? []), t]);
  const rows: ListRow[] = [];
  const seen = new Set<string>();
  const place = (t: BoardIssue, depth: number, underParent: boolean) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    const kids = here.get(t.id) ?? [];
    rows.push(row(t, depth, kids.length, !underParent));
    if (!opts.folded.has(t.id)) for (const k of kids) place(k, depth + 1, true);
    else hide(t.id);
  };
  /** Everything below a folded parent is accounted for (hidden), so the rescue of unreachable issues below does not bring it back. */
  const hide = (id: string) => {
    for (const k of here.get(id) ?? []) {
      if (seen.has(k.id)) continue;
      seen.add(k.id);
      hide(k.id);
    }
  };
  for (const t of list) if (!t.parentId || !inList.has(t.parentId)) place(t, 0, false);
  // Bad data (parents that loop) leaves issues no walk reaches: show them as rows of their own rather than lose them.
  for (const t of list) place(t, 0, false);
  return rows;
}

/** What a card or a row needs to know about an issue's place in a tree: whose sub-issue it is, and how its own sub-issues are getting on. */
export type Relations = { parentRef: (t: BoardIssue) => string | null; progress: (t: BoardIssue) => Progress | null };

export function relationsOf(all: BoardIssue[], roleOf: (statusId: string) => string | null): Relations {
  const index = childrenIndex(all);
  const byId = new Map(all.map((t) => [t.id, t]));
  return {
    parentRef: (t) => (t.parentId ? (byId.get(t.parentId)?.ref ?? null) : null),
    progress: (t) => progressOf(t.id, index, roleOf),
  };
}
