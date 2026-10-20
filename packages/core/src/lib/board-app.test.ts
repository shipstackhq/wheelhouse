import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { columnField, intField, issueInput } from "./board-app";
import { ServiceError } from "./service";

/** Reading a request body for the board and issue endpoints: nothing wrong-typed gets past here to the database. */
const fieldsOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ServiceError && e.code === "invalid", `expected an invalid ServiceError, got ${String(e)}`);
    return Object.keys((e.details as { fields: Record<string, string> }).fields);
  }
  return assert.fail("expected an error");
};

describe("issueInput", () => {
  test("a new issue needs a title; the title is trimmed", () => {
    assert.deepEqual(issueInput({ title: "  Hello  " }, { create: true }), { title: "Hello" });
    assert.deepEqual(fieldsOf(() => issueInput({}, { create: true })), ["title"]);
    assert.deepEqual(fieldsOf(() => issueInput({ title: "   " }, { create: true })), ["title"]);
  });

  test("an edit carries only what was sent", () => {
    assert.deepEqual(issueInput({}, { create: false }), {});
    assert.deepEqual(issueInput({ priority: "high", labels: [] }, { create: false }), { priority: "high", labels: [] });
    assert.deepEqual(issueInput({ body: "" }, { create: false }), { body: "" }, "an empty body is a real change");
  });

  test("an assignee can be cleared with null or an empty string, and set with an id", () => {
    assert.deepEqual(issueInput({ assigneeId: null }, { create: false }), { assigneeId: null });
    assert.deepEqual(issueInput({ assigneeId: "" }, { create: false }), { assigneeId: null });
    assert.deepEqual(issueInput({ assigneeId: "abc" }, { create: false }), { assigneeId: "abc" });
  });

  test("every wrong type is a field error naming it", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ title: 1 }, "title"],
      [{ title: "" }, "title"],
      [{ body: 1 }, "body"],
      [{ body: null }, "body"],
      [{ priority: "critical" }, "priority"],
      [{ priority: 1 }, "priority"],
      [{ assigneeId: 1 }, "assigneeId"],
      [{ agentClaimable: "true" }, "agentClaimable"],
      [{ agentClaimable: 1 }, "agentClaimable"],
      [{ labels: "bug" }, "labels"],
      [{ labels: ["ok", 2] }, "labels"],
      [{ labels: [null] }, "labels"],
    ];
    for (const [body, field] of cases) assert.deepEqual(fieldsOf(() => issueInput(body, { create: false })), [field], JSON.stringify(body));
  });

  test("unknown fields are ignored, not passed on", () => {
    assert.deepEqual(issueInput({ title: "x", teamId: "other", version: 3, createdById: "z" }, { create: true }), { title: "x" });
  });
});

describe("intField and columnField", () => {
  test("a whole number, or absent", () => {
    assert.equal(intField({ n: 3 }, "n"), 3);
    assert.equal(intField({ n: 0 }, "n"), 0);
    assert.equal(intField({ n: -1 }, "n"), -1);
    assert.equal(intField({}, "n"), undefined);
    assert.equal(intField({ n: null }, "n"), undefined);
    for (const n of ["3", 1.5, NaN, Infinity, 2 ** 60, true, []]) assert.deepEqual(fieldsOf(() => intField({ n }, "n")), ["n"], String(n));
  });

  test("a column is text, and required where it must be", () => {
    assert.equal(columnField({ column: "Done" }, true), "Done");
    assert.equal(columnField({}, false), undefined);
    assert.deepEqual(fieldsOf(() => columnField({}, true)), ["column"]);
    for (const column of [3, "", "  ", {}, []]) assert.deepEqual(fieldsOf(() => columnField({ column }, true)), ["column"], JSON.stringify(column));
  });
});
