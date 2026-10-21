import { describe, expect, test } from "vitest";
import { groupStatuses, reorderWithinGroup, ROLE_LABEL, type Ordered } from "./status-order";

const s = (id: string, role: Ordered["role"]): Ordered => ({ id, role });
const BOARD = [s("b1", "backlog"), s("t1", "todo"), s("t2", "todo"), s("p1", "in_progress"), s("x1", null), s("d1", "done"), s("c1", "canceled")];

describe("grouping statuses by role", () => {
  test("groups come in the order of the roles, each in board order, with role-less statuses last as 'No role'", () => {
    expect(groupStatuses(BOARD).map((g) => [g.role, g.label, g.items.map((i) => i.id)])).toEqual([
      ["backlog", "Backlog", ["b1"]],
      ["todo", "Todo", ["t1", "t2"]],
      ["in_progress", "In progress", ["p1"]],
      ["done", "Done", ["d1"]],
      ["canceled", "Canceled", ["c1"]],
      [null, "No role", ["x1"]],
    ]);
  });
  test("a role nobody has is not a group, and no role-less status means no 'No role' group", () => {
    expect(groupStatuses([s("a", "todo")]).map((g) => g.role)).toEqual(["todo"]);
    expect(groupStatuses([])).toEqual([]);
  });
  test("every role has a label", () => {
    expect(Object.keys(ROLE_LABEL)).toEqual(["backlog", "todo", "in_progress", "review", "done", "canceled"]);
  });
});

describe("reordering inside a group", () => {
  test("dropping a status on another of its role puts it there, and nothing else moves", () => {
    expect(reorderWithinGroup(BOARD, "todo", "t1", "t2")).toEqual(["b1", "t2", "t1", "p1", "x1", "d1", "c1"]);
    expect(reorderWithinGroup(BOARD, "todo", "t2", "t1")).toEqual(["b1", "t2", "t1", "p1", "x1", "d1", "c1"]);
  });
  test("a role-less status that sits between two of a group stays where it is", () => {
    const mixed = [s("a1", "todo"), s("n1", null), s("a2", "todo"), s("n2", null), s("a3", "todo")];
    expect(reorderWithinGroup(mixed, "todo", "a3", "a1")).toEqual(["a3", "n1", "a1", "n2", "a2"]);
    expect(reorderWithinGroup(mixed, null, "n2", "n1")).toEqual(["a1", "n2", "a2", "n1", "a3"]);
  });
  test("a drop on itself, on another group's status or on one that is not there changes nothing", () => {
    const ids = BOARD.map((x) => x.id);
    expect(reorderWithinGroup(BOARD, "todo", "t1", "t1")).toEqual(ids);
    expect(reorderWithinGroup(BOARD, "todo", "t1", "p1")).toEqual(ids);
    expect(reorderWithinGroup(BOARD, "todo", "t1", "nope")).toEqual(ids);
  });
  test("the answer always names every status once, so the server accepts it", () => {
    const out = reorderWithinGroup(BOARD, "todo", "t2", "t1");
    expect([...out].sort()).toEqual(BOARD.map((x) => x.id).sort());
  });
});
