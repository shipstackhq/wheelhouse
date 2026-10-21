import { afterEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_VIEW, EMPTY_FILTERS, FILTER_KEYS, fieldPatch, filterCount, filterOptions, filterIssues, groupIssues, isFiltered, loadIssueView, matchesSearch, parseView, retagIssue, saveIssueView, sortIssues, startingFields, type IssueView } from "./issue-view";
import { issue, STATUSES } from "../test/data";

afterEach(() => vi.restoreAllMocks());

type Over = Omit<Partial<IssueView>, "filters"> & { filters?: Partial<IssueView["filters"]> };
const v = (over: Over = {}): IssueView => ({ ...DEFAULT_VIEW, ...over, filters: { ...EMPTY_FILTERS, ...(over.filters ?? {}) } });
const refs = (list: { ref: string }[]) => list.map((t) => t.ref);

const A = issue({ number: 1, title: "Fix login bug", statusId: "c-todo", priority: "high", assigneeId: "u1", labels: ["auth", "Bug"], projectId: "p1", cycle: 2, position: 3, updatedAt: "2026-10-05T00:00:00.000Z", createdAt: "2026-10-01T00:00:00.000Z" });
const B = issue({ number: 2, title: "Write docs", statusId: "c-backlog", priority: "none", assigneeId: null, labels: [], projectId: null, cycle: null, position: 1, updatedAt: "2026-10-09T00:00:00.000Z", createdAt: "2026-10-02T00:00:00.000Z" });
const C = issue({ number: 3, title: "bug in billing", statusId: "c-todo", priority: "urgent", assigneeId: "u2", labels: ["billing"], projectId: "p1", cycle: 3, position: 2, updatedAt: "2026-10-07T00:00:00.000Z", createdAt: "2026-10-03T00:00:00.000Z" });
const D = issue({ number: 4, title: "Ship it", statusId: "c-done", priority: "low", assigneeId: "u1", labels: ["release"], projectId: "p2", cycle: 2, position: 4, updatedAt: "2026-10-01T00:00:00.000Z", createdAt: "2026-10-04T00:00:00.000Z" });
const ALL = [A, B, C, D];
const CTX = {
  statuses: STATUSES,
  members: [{ id: "u2", name: "Grace Hopper" }, { id: "u1", name: "Ada Lovelace" }],
  projects: [{ id: "p2", name: "Zeta", status: "active" as const, milestones: [] }, { id: "p1", name: "Alpha", status: "active" as const, milestones: [] }],
  cycles: [{ number: 3, name: "", startsAt: "", endsAt: "", state: "current" as const }, { number: 2, name: "Autumn", startsAt: "", endsAt: "", state: "past" as const }],
};

describe("search", () => {
  test("every word must be found in the ref, the title or a label, in any case", () => {
    expect(matchesSearch(A, "login")).toBe(true);
    expect(matchesSearch(A, "LOGIN BUG")).toBe(true);
    expect(matchesSearch(A, "bug login")).toBe(true); // any order
    expect(matchesSearch(A, "AA-1")).toBe(true); // the ref
    expect(matchesSearch(A, "auth")).toBe(true); // a label
    expect(matchesSearch(A, "login billing")).toBe(false); // one word missing
    expect(matchesSearch(A, "")).toBe(true);
    expect(matchesSearch(A, "   ")).toBe(true);
  });
});

describe("filters", () => {
  test("nothing chosen keeps every issue; a search alone counts as filtering", () => {
    expect(filterIssues(ALL, v())).toBe(ALL);
    expect(isFiltered(v())).toBe(false);
    expect(isFiltered(v({ search: "x" }))).toBe(true);
    expect(isFiltered(v({ search: "  " }))).toBe(false);
  });
  test("each filter keeps what it lists; filters together keep what passes all of them", () => {
    expect(refs(filterIssues(ALL, v({ filters: { status: ["c-todo"] } })))).toEqual(["AA-1", "AA-3"]);
    expect(refs(filterIssues(ALL, v({ filters: { status: ["c-todo", "c-done"] } })))).toEqual(["AA-1", "AA-3", "AA-4"]);
    expect(refs(filterIssues(ALL, v({ filters: { priority: ["urgent", "high"] } })))).toEqual(["AA-1", "AA-3"]);
    expect(refs(filterIssues(ALL, v({ filters: { assignee: ["u1"] } })))).toEqual(["AA-1", "AA-4"]);
    expect(refs(filterIssues(ALL, v({ filters: { status: ["c-todo"], assignee: ["u1"] } })))).toEqual(["AA-1"]);
    expect(refs(filterIssues(ALL, v({ filters: { status: ["c-done"], assignee: ["u2"] } })))).toEqual([]);
  });
  test("'none' keeps the issues with no assignee, project or cycle, alone or with others", () => {
    expect(refs(filterIssues(ALL, v({ filters: { assignee: ["none"] } })))).toEqual(["AA-2"]);
    expect(refs(filterIssues(ALL, v({ filters: { assignee: ["none", "u2"] } })))).toEqual(["AA-2", "AA-3"]);
    expect(refs(filterIssues(ALL, v({ filters: { project: ["none"] } })))).toEqual(["AA-2"]);
    expect(refs(filterIssues(ALL, v({ filters: { cycle: ["none"] } })))).toEqual(["AA-2"]);
    expect(refs(filterIssues(ALL, v({ filters: { project: ["p1"] } })))).toEqual(["AA-1", "AA-3"]);
  });
  test("a cycle is matched by its number as text, and a label if the issue has any of those chosen", () => {
    expect(refs(filterIssues(ALL, v({ filters: { cycle: ["2"] } })))).toEqual(["AA-1", "AA-4"]);
    expect(refs(filterIssues(ALL, v({ filters: { label: ["billing", "release"] } })))).toEqual(["AA-3", "AA-4"]);
    expect(refs(filterIssues(ALL, v({ filters: { label: ["bug"] } })))).toEqual([]); // labels are matched exactly, as they are shown
  });
  test("search and filters narrow together", () => {
    expect(refs(filterIssues(ALL, v({ search: "bug" })))).toEqual(["AA-1", "AA-3"]);
    expect(refs(filterIssues(ALL, v({ search: "bug", filters: { priority: ["urgent"] } })))).toEqual(["AA-3"]);
  });
  test("filterCount counts the chosen values, not the search", () => {
    expect(filterCount(v({ search: "x", filters: { status: ["a", "b"], label: ["c"] } }))).toBe(3);
  });
});

describe("ordering", () => {
  test("manual is the board order, whatever the direction", () => {
    expect(refs(sortIssues(ALL, { key: "manual", dir: "asc" }))).toEqual(["AA-2", "AA-3", "AA-1", "AA-4"]);
    expect(refs(sortIssues(ALL, { key: "manual", dir: "desc" }))).toEqual(["AA-2", "AA-3", "AA-1", "AA-4"]);
  });
  test("priority puts the most pressing first, no priority last; descending reverses it", () => {
    expect(refs(sortIssues(ALL, { key: "priority", dir: "asc" }))).toEqual(["AA-3", "AA-1", "AA-4", "AA-2"]);
    expect(refs(sortIssues(ALL, { key: "priority", dir: "desc" }))).toEqual(["AA-2", "AA-4", "AA-1", "AA-3"]);
  });
  test("by date, title and number; the title ignores case", () => {
    expect(refs(sortIssues(ALL, { key: "updated", dir: "desc" }))).toEqual(["AA-2", "AA-3", "AA-1", "AA-4"]);
    expect(refs(sortIssues(ALL, { key: "created", dir: "asc" }))).toEqual(["AA-1", "AA-2", "AA-3", "AA-4"]);
    expect(refs(sortIssues(ALL, { key: "title", dir: "asc" }))).toEqual(["AA-3", "AA-1", "AA-4", "AA-2"]); // bug in, Fix, Ship, Write
    expect(refs(sortIssues(ALL, { key: "number", dir: "desc" }))).toEqual(["AA-4", "AA-3", "AA-2", "AA-1"]);
  });
  test("equal values keep the board order, and the input is not changed", () => {
    const same = [issue({ number: 5, priority: "high", position: 9 }), issue({ number: 6, priority: "high", position: 8 })];
    expect(refs(sortIssues(same, { key: "priority", dir: "asc" }))).toEqual(["AA-6", "AA-5"]);
    expect(refs(same)).toEqual(["AA-5", "AA-6"]);
  });
});

describe("grouping", () => {
  const by = (groupBy: IssueView["groupBy"], over: Partial<IssueView> = {}, issues = ALL) => groupIssues(issues, v({ groupBy, ...over }), CTX);
  const shape = (gs: ReturnType<typeof by>) => gs.map((g) => [g.label, refs(g.issues)]);

  test("by status: every status in board order, empty ones too, each group in the view's order", () => {
    const gs = by("status");
    expect(gs.map((g) => g.label)).toEqual(STATUSES.map((s) => s.name));
    expect(shape(gs).slice(0, 3)).toEqual([["Backlog", ["AA-2"]], ["Todo", ["AA-3", "AA-1"]], ["In Progress", []]]);
    expect(gs[0].id).toBe("status:c-backlog");
  });
  test("by status while filtering, the empty groups go", () => {
    // The page filters first and then groups; the view tells the grouping that something is filtered.
    const narrowed = (over: Over) => {
      const view = v({ groupBy: "status", ...over });
      return shape(groupIssues(filterIssues(ALL, view), view, CTX));
    };
    expect(narrowed({ filters: { priority: ["urgent"] } })).toEqual([["Todo", ["AA-3"]]]);
    expect(narrowed({ search: "zzz" })).toEqual([]);
    // a board keeps its columns however much is filtered
    const view = v({ groupBy: "status", filters: { priority: ["urgent"] } });
    expect(groupIssues(filterIssues(ALL, view), view, CTX, { keepEmpty: true }).map((g) => g.label)).toEqual(STATUSES.map((s) => s.name));
  });
  test("by priority: most pressing first, only groups with issues", () => {
    expect(shape(by("priority"))).toEqual([["Urgent", ["AA-3"]], ["High", ["AA-1"]], ["Low", ["AA-4"]], ["No priority", ["AA-2"]]]);
  });
  test("by assignee: people by name, unassigned last", () => {
    expect(shape(by("assignee"))).toEqual([["Ada Lovelace", ["AA-1", "AA-4"]], ["Grace Hopper", ["AA-3"]], ["Unassigned", ["AA-2"]]]);
  });
  test("by project: projects by name, 'No project' last", () => {
    expect(shape(by("project"))).toEqual([["Alpha", ["AA-3", "AA-1"]], ["Zeta", ["AA-4"]], ["No project", ["AA-2"]]]);
  });
  test("by cycle: the team's cycles in the order given, 'No cycle' last, a name only when it has one", () => {
    expect(shape(by("cycle"))).toEqual([["Cycle 3", ["AA-3"]], ["Cycle 2: Autumn", ["AA-1", "AA-4"]], ["No cycle", ["AA-2"]]]);
  });
  test("for a board every group stays, even with nothing in it, so a card can be dropped into any of them", () => {
    const all = (groupBy: IssueView["groupBy"]) => groupIssues([B], v({ groupBy }), CTX, { keepEmpty: true }).map((g) => g.label);
    expect(all("priority")).toEqual(["Urgent", "High", "Medium", "Low", "No priority"]);
    expect(all("assignee")).toEqual(["Ada Lovelace", "Grace Hopper", "Unassigned"]);
    expect(all("project")).toEqual(["Alpha", "Zeta", "No project"]);
    expect(all("cycle")).toEqual(["Cycle 3", "Cycle 2: Autumn", "No cycle"]);
    // a list leaves them out
    expect(groupIssues([B], v({ groupBy: "priority" }), CTX).map((g) => g.label)).toEqual(["No priority"]);
  });
  test("with no grouping there is one group of everything, even nothing", () => {
    expect(shape(by("none"))).toEqual([["All issues", ["AA-2", "AA-3", "AA-1", "AA-4"]]]);
    expect(shape(by("none", {}, []))).toEqual([["All issues", []]]);
  });
  test("the sort applies inside every group", () => {
    expect(shape(by("assignee", { sort: { key: "number", dir: "desc" } }))[0]).toEqual(["Ada Lovelace", ["AA-4", "AA-1"]]);
  });
  test("every group id is distinct and says how the issues are grouped, so folding one grouping does not fold another", () => {
    const ids = [...by("status"), ...by("priority"), ...by("assignee"), ...by("project"), ...by("cycle"), ...by("none")].map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(by("priority")[0].id).toBe("priority:urgent");
  });
});

describe("what a new issue in a group starts with", () => {
  test("the status, priority, person, project or cycle of the group; nothing for 'none of these' or no grouping", () => {
    const g = (groupBy: IssueView["groupBy"]) => groupIssues(ALL, v({ groupBy }), CTX);
    expect(startingFields(g("status")[2].what)).toEqual({ status: "c-progress" });
    expect(startingFields(g("priority")[0].what)).toEqual({ priority: "urgent" });
    expect(startingFields(g("assignee")[0].what)).toEqual({ assigneeId: "u1" });
    expect(startingFields(g("assignee").at(-1)!.what)).toEqual({});
    expect(startingFields(g("project")[0].what)).toEqual({ projectId: "p1" });
    expect(startingFields(g("cycle")[0].what)).toEqual({ cycle: 3 });
    expect(startingFields(g("cycle").at(-1)!.what)).toEqual({});
    expect(startingFields(g("none")[0].what)).toEqual({});
  });
});

describe("remembering the view", () => {
  test("a team that has not set one gets the default; a saved view is read back, without the search", () => {
    localStorage.clear();
    expect(loadIssueView("AA")).toEqual(DEFAULT_VIEW);
    const mine = v({ groupBy: "priority", sort: { key: "updated", dir: "desc" }, search: "typed", filters: { status: ["c-todo"], label: ["docs"] } });
    saveIssueView("AA", mine);
    expect(loadIssueView("AA")).toEqual({ ...mine, search: "" });
    expect(loadIssueView("BB")).toEqual(DEFAULT_VIEW);
  });
  test("damaged or unknown parts are replaced by the default for that part, never thrown", () => {
    expect(parseView(null)).toEqual(DEFAULT_VIEW);
    expect(parseView("nope")).toEqual(DEFAULT_VIEW);
    expect(parseView({ groupBy: "colour", sort: { key: "magic", dir: "sideways" }, filters: { status: "c-todo", priority: [1, "high", null], extra: ["x"] }, search: 4 })).toEqual({
      ...DEFAULT_VIEW,
      filters: { ...EMPTY_FILTERS, priority: ["high"] },
    });
    expect(parseView({ groupBy: "assignee", sort: { key: "title", dir: "desc" } })).toMatchObject({ groupBy: "assignee", sort: { key: "title", dir: "desc" } });
    localStorage.setItem("wh:issue-view:AA", "{broken");
    expect(loadIssueView("AA")).toEqual(DEFAULT_VIEW);
  });
  test("without storage it still answers, and saving does not throw", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(loadIssueView("AA")).toEqual(DEFAULT_VIEW);
    expect(() => saveIssueView("AA", DEFAULT_VIEW)).not.toThrow();
  });
});

describe("what each filter offers", () => {
  const ctx = { ...CTX, labels: ["docs", "api"] };
  const opts = (k: (typeof FILTER_KEYS)[number]) => filterOptions(k, ctx).map((o) => [o.value, o.label]);
  test("statuses in board order, priorities most pressing first, people and projects by name, labels as given", () => {
    expect(opts("status").map((o) => o[1])).toEqual(STATUSES.map((s) => s.name));
    expect(opts("priority")).toEqual([["urgent", "Urgent"], ["high", "High"], ["medium", "Medium"], ["low", "Low"], ["none", "No priority"]]);
    expect(opts("label")).toEqual([["docs", "docs"], ["api", "api"]]);
  });
  test("assignee, project and cycle end with the value for 'none of these', which is the value the filter understands", () => {
    expect(opts("assignee")).toEqual([["u1", "Ada Lovelace"], ["u2", "Grace Hopper"], ["none", "Unassigned"]]);
    expect(opts("project")).toEqual([["p1", "Alpha"], ["p2", "Zeta"], ["none", "No project"]]);
    expect(opts("cycle")).toEqual([["3", "Cycle 3"], ["2", "Cycle 2: Autumn"], ["none", "No cycle"]]);
    for (const k of ["assignee", "project", "cycle"] as const) {
      const none = filterOptions(k, ctx).at(-1)!.value;
      expect(filterIssues(ALL, v({ filters: { [k]: [none] } })).length).toBeGreaterThan(0);
    }
  });
  test("every filter key has options, so a menu section can be drawn for each", () => {
    for (const k of FILTER_KEYS) expect(filterOptions(k, ctx).length).toBeGreaterThan(0);
  });
});

describe("dropping an issue into a group", () => {
  const g = (groupBy: IssueView["groupBy"]) => groupIssues(ALL, v({ groupBy }), CTX);
  test("it takes on what the group is, and nothing else; leaving a project clears its milestone", () => {
    expect(retagIssue(g("status")[0].what, A)).toEqual({ ...A, statusId: "c-backlog" });
    expect(retagIssue(g("priority")[0].what, A)).toEqual({ ...A, priority: "urgent" });
    expect(retagIssue(g("assignee")[1].what, A)).toEqual({ ...A, assigneeId: "u2" });
    expect(retagIssue(g("assignee").at(-1)!.what, A).assigneeId).toBeNull();
    expect(retagIssue(g("project")[1].what, { ...A, milestoneId: "m1" })).toEqual({ ...A, projectId: "p2", milestoneId: null });
    expect(retagIssue(g("project").at(-1)!.what, A).projectId).toBeNull();
    expect(retagIssue(g("cycle")[1].what, A).cycle).toBe(2);
    expect(retagIssue(g("cycle").at(-1)!.what, A).cycle).toBeNull();
    expect(retagIssue(g("none")[0].what, A)).toBe(A);
  });
  test("the server is told the one field the grouping is by; for a status group (a move) and no grouping there is no patch", () => {
    expect(fieldPatch(g("priority")[2].what)).toEqual({ priority: "low" });
    expect(fieldPatch(g("assignee")[0].what)).toEqual({ assigneeId: "u1" });
    expect(fieldPatch(g("assignee").at(-1)!.what)).toEqual({ assigneeId: null });
    expect(fieldPatch(g("project")[0].what)).toEqual({ projectId: "p1" });
    expect(fieldPatch(g("project").at(-1)!.what)).toEqual({ projectId: null });
    expect(fieldPatch(g("cycle")[0].what)).toEqual({ cycle: 3 });
    expect(fieldPatch(g("cycle").at(-1)!.what)).toEqual({ cycle: null });
    expect(fieldPatch(g("status")[0].what)).toBeNull();
    expect(fieldPatch(g("none")[0].what)).toBeNull();
  });
});
