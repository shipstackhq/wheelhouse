import { afterEach, describe, expect, test } from "vitest";
import { EMPTY_VIEW, applyView, describeFilter, describeSort, isFiltered, loadView, matches, saveView, type View } from "./column-controls";
import { issue } from "../../test/data";

/** A column's filter and sort: filters combine with AND, several values inside one filter with OR, and the choice is remembered per column. */
const t1 = issue({ number: 1, title: "Banana", priority: "high", labels: ["bug"], assigneeId: "u1", agentClaimable: true, commentCount: 3, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z" });
const t2 = issue({ number: 2, title: "apple", priority: "low", labels: ["docs"], assigneeId: null, createdByKind: "agent", createdAt: "2026-10-02T00:00:00Z", updatedAt: "2026-10-03T00:00:00Z" });
const t3 = issue({ number: 3, title: "Cherry", priority: "urgent", labels: ["bug", "docs"], assigneeId: "u2", claimedByKeyId: "k1", nodeIds: ["n1"], createdAt: "2026-10-03T00:00:00Z", updatedAt: "2026-10-04T00:00:00Z" });
const all = [t1, t2, t3];
const view = (over: Partial<View>): View => ({ ...EMPTY_VIEW, ...over });
const refs = (list: typeof all) => list.map((t) => t.number);

afterEach(() => localStorage.clear());

describe("filters", () => {
  test("no filter shows everything, in the order given", () => {
    expect(isFiltered(EMPTY_VIEW)).toBe(false);
    expect(refs(applyView(all, EMPTY_VIEW))).toEqual([1, 2, 3]);
  });

  test("several values of one filter are OR: high or urgent", () => {
    expect(refs(applyView(all, view({ priority: ["high", "urgent"] })))).toEqual([1, 3]);
  });

  test("different filters are AND: a bug that is urgent", () => {
    expect(refs(applyView(all, view({ label: ["bug"], priority: ["urgent"] })))).toEqual([3]);
  });

  test("assignee: a person, or 'none' for unassigned", () => {
    expect(refs(applyView(all, view({ assignee: ["u1"] })))).toEqual([1]);
    expect(refs(applyView(all, view({ assignee: ["none"] })))).toEqual([2]);
    expect(refs(applyView(all, view({ assignee: ["none", "u2"] })))).toEqual([2, 3]);
  });

  test("each flag is its own filter, and flags combine with AND", () => {
    expect(refs(applyView(all, view({ flags: ["aiReady"] })))).toEqual([1]);
    expect(refs(applyView(all, view({ flags: ["claimed"] })))).toEqual([3]);
    expect(refs(applyView(all, view({ flags: ["byAgent"] })))).toEqual([2]);
    expect(refs(applyView(all, view({ flags: ["linked"] })))).toEqual([3]);
    expect(refs(applyView(all, view({ flags: ["hasComments"] })))).toEqual([1]);
    expect(refs(applyView(all, view({ flags: ["aiReady", "hasComments"] })))).toEqual([1]);
    expect(refs(applyView(all, view({ flags: ["aiReady", "byAgent"] })))).toEqual([]);
  });

  test("an issue the filter hides can be kept showing (an issue just added stays visible)", () => {
    expect(refs(applyView(all, view({ priority: ["urgent"] }), (t) => t.number === 2))).toEqual([2, 3]);
  });

  test("matches says the same thing for one issue", () => {
    expect(matches(t1, view({ priority: ["high"] }))).toBe(true);
    expect(matches(t1, view({ priority: ["low"] }))).toBe(false);
  });
});

describe("sorting", () => {
  const sorted = (key: View["sort"] extends infer S ? (S extends { key: infer K } ? K : never) : never, dir: "asc" | "desc") => refs(applyView(all, view({ sort: { key, dir } })));

  test("by priority: urgent first when descending, and the order is stable by number on ties", () => {
    expect(sorted("priority", "asc")).toEqual([3, 1, 2]);
    expect(sorted("priority", "desc")).toEqual([2, 1, 3]);
  });
  test("by title, ignoring case", () => {
    expect(sorted("title", "asc")).toEqual([2, 1, 3]);
    expect(sorted("title", "desc")).toEqual([3, 1, 2]);
  });
  test("by number, created, last updated and comment count", () => {
    expect(sorted("number", "desc")).toEqual([3, 2, 1]);
    expect(sorted("created", "asc")).toEqual([1, 2, 3]);
    expect(sorted("updated", "desc")).toEqual([1, 3, 2]);
    expect(sorted("comments", "desc")).toEqual([1, 2, 3]);
  });
  test("sorting never changes the list it was given", () => {
    const copy = [...all];
    applyView(all, view({ sort: { key: "title", dir: "asc" } }));
    expect(all).toEqual(copy);
  });
  test("a filter and a sort together", () => {
    expect(refs(applyView(all, view({ label: ["bug"], sort: { key: "number", dir: "desc" } })))).toEqual([3, 1]);
  });
});

describe("what the controls say", () => {
  test("a filter's label: one value by name, several as a count, a mix as 'N applied'", () => {
    const members = [{ kind: "human" as const, id: "u1", name: "Ada Lovelace", avatar: null }];
    expect(describeFilter(view({ priority: ["high"] }), members)).toBe("High priority");
    expect(describeFilter(view({ priority: ["high", "low"] }), members)).toBe("2 priorities");
    expect(describeFilter(view({ assignee: ["u1"] }), members)).toBe("Ada Lovelace");
    expect(describeFilter(view({ assignee: ["none"] }), members)).toBe("Unassigned");
    expect(describeFilter(view({ label: ["bug"] }), members)).toBe("bug");
    expect(describeFilter(view({ flags: ["aiReady"] }), members)).toBe("AI-ready");
    expect(describeFilter(view({ priority: ["high"], label: ["bug"] }), members)).toBe("2 applied");
  });
  test("a sort's label has the direction", () => {
    expect(describeSort(view({ sort: { key: "priority", dir: "desc" } }))).toBe("Priority ↓");
    expect(describeSort(view({ sort: { key: "title", dir: "asc" } }))).toBe("Title ↑");
    expect(describeSort(EMPTY_VIEW)).toBe("");
  });
});

describe("remembering a column's view", () => {
  test("a filter or sort is saved and comes back; an empty view removes what was saved", () => {
    const v = view({ priority: ["high"], sort: { key: "title", dir: "asc" } });
    saveView("wh:view:AA:c1", v);
    expect(loadView("wh:view:AA:c1")).toEqual(v);
    saveView("wh:view:AA:c1", EMPTY_VIEW);
    expect(localStorage.getItem("wh:view:AA:c1")).toBeNull();
    expect(loadView("wh:view:AA:c1")).toEqual(EMPTY_VIEW);
  });
  test("views are kept apart per team and column", () => {
    saveView("wh:view:AA:c1", view({ label: ["bug"] }));
    expect(loadView("wh:view:AA:c2")).toEqual(EMPTY_VIEW);
    expect(loadView("wh:view:BB:c1")).toEqual(EMPTY_VIEW);
  });
  test("something unreadable in storage is ignored, and a saved view missing newer fields still loads", () => {
    localStorage.setItem("wh:view:x", "{not json");
    expect(loadView("wh:view:x")).toEqual(EMPTY_VIEW);
    localStorage.setItem("wh:view:y", JSON.stringify({ priority: ["low"] }));
    expect(loadView("wh:view:y")).toEqual(view({ priority: ["low"] }));
  });
  test("it does not need storage to work (a browser that refuses it)", () => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("blocked");
    };
    try {
      expect(() => saveView("wh:view:z", view({ label: ["a"] }))).not.toThrow();
    } finally {
      Storage.prototype.setItem = real;
    }
  });
});
