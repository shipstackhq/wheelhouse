import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { columnForRole, COLUMN_ROLES, DEFAULT_COLUMN_DEFS, hasRole, idsWithRole, roleFromText, type RoleColumn } from "./column-roles";

describe("column roles", () => {
  test("a new board has the five standard columns, each with its own role, in order", () => {
    assert.deepEqual(DEFAULT_COLUMN_DEFS.map((c) => c.name), ["Backlog", "Todo", "In Progress", "Review", "Done"]);
    assert.deepEqual(DEFAULT_COLUMN_DEFS.map((c) => c.role), [...COLUMN_ROLES]);
  });
  test("text is read as a role regardless of case, spaces, dashes or underscores; anything else is no role", () => {
    for (const t of ["In Progress", "in progress", "in-progress", "IN_PROGRESS", "  in progress  "]) assert.equal(roleFromText(t), "in_progress", t);
    assert.equal(roleFromText("Review"), "review");
    for (const t of ["QA", "Blocked", "", "reviewing", "in progres"]) assert.equal(roleFromText(t), null, t);
  });
  test("the column for a role is the first with it in board order, or none", () => {
    const cols: RoleColumn[] = [{ id: "1", name: "Todo", role: "todo" }, { id: "2", name: "Code review", role: "review" }, { id: "3", name: "Design review", role: "review" }];
    assert.equal(columnForRole(cols, "review")?.id, "2");
    assert.equal(columnForRole(cols, "done"), undefined);
  });
  test("hasRole and idsWithRole ignore names, and a missing or role-less column has no role", () => {
    const cols = [{ id: "1", name: "Review", role: null }, { id: "2", name: "QA", role: "review" as const }, { id: "3", name: "Shipped", role: "done" as const }];
    assert.equal(hasRole(cols[0], "review"), false);
    assert.equal(hasRole(cols[1], "review", "done"), true);
    assert.equal(hasRole(undefined, "done"), false);
    assert.deepEqual([...idsWithRole(cols, "review")], ["2"]);
    assert.deepEqual([...idsWithRole(cols, "done")], ["3"]);
  });
});
