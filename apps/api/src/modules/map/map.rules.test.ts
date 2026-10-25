import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { layoutInput, nodeInput } from "./map.rules";
import { bad, finite, oneOf, text, textList, textOrNull, whole } from "../../common/http/web-input";
import { ServiceError } from "../../common/service-error";

/** Reading a request body for the map's endpoints: nothing wrong-typed gets past here to the database. */
const fieldsOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ServiceError && e.code === "invalid", `expected an invalid ServiceError, got ${String(e)}`);
    return Object.keys((e.details as { fields: Record<string, string> }).fields);
  }
  return assert.fail("expected an error");
};

describe("the field readers", () => {
  test("text: absent is undefined, a string is kept (trimmed on request), anything else names the field", () => {
    assert.equal(text({}, "a"), undefined);
    assert.equal(text({ a: " x " }, "a"), " x ");
    assert.equal(text({ a: " x " }, "a", { trim: true }), "x");
    assert.deepEqual(fieldsOf(() => text({ a: 1 }, "a")), ["a"]);
    assert.deepEqual(fieldsOf(() => text({}, "a", { required: true })), ["a"]);
    assert.deepEqual(fieldsOf(() => text({ a: "  " }, "a", { required: true })), ["a"]);
    assert.deepEqual(fieldsOf(() => text({ a: "toolong" }, "a", { max: 3 })), ["a"]);
  });
  test("textOrNull: null and an empty string clear, absent changes nothing", () => {
    assert.equal(textOrNull({}, "a"), undefined);
    assert.equal(textOrNull({ a: null }, "a"), null);
    assert.equal(textOrNull({ a: "" }, "a"), null);
    assert.equal(textOrNull({ a: "x" }, "a"), "x");
    assert.deepEqual(fieldsOf(() => textOrNull({ a: 5 }, "a")), ["a"]);
  });
  test("oneOf, textList, whole and finite", () => {
    assert.equal(oneOf({ a: "x" }, "a", ["x", "y"] as const), "x");
    assert.deepEqual(fieldsOf(() => oneOf({ a: "z" }, "a", ["x", "y"] as const)), ["a"]);
    assert.deepEqual(fieldsOf(() => oneOf({}, "a", ["x"] as const, true)), ["a"]);
    assert.deepEqual(textList({ a: ["p", "q"] }, "a"), ["p", "q"]);
    for (const a of ["p", [1], [null], { 0: "p" }]) assert.deepEqual(fieldsOf(() => textList({ a }, "a")), ["a"], JSON.stringify(a));
    assert.deepEqual(fieldsOf(() => textList({ a: ["1", "2", "3"] }, "a", 2)), ["a"]);
    assert.equal(whole({ a: 3 }, "a"), 3);
    for (const a of ["3", 1.5, NaN, true]) assert.deepEqual(fieldsOf(() => whole({ a }, "a")), ["a"], String(a));
    assert.equal(finite(2.5, "x"), 2.5);
    for (const v of ["1", NaN, Infinity, null]) assert.deepEqual(fieldsOf(() => finite(v, "x")), ["x"], String(v));
    assert.deepEqual(fieldsOf(() => bad("f", "no")), ["f"]);
  });
});

describe("nodeInput", () => {
  test("takes what the panel sets, and only that: unknown fields (including ones that would skip the safeguards) are ignored", () => {
    const out = nodeInput({ name: "A", summary: "s", status: "live", anchors: [" a ", ""], parent: null, forcePublish: true, markFresh: true, describedHashes: { a: "b" }, teamId: "x", id: "ignored-here" });
    assert.deepEqual(out, { name: "A", summary: "s", status: "live", anchors: ["a"], parent: null });
  });
  test("every wrong type is a field error naming it", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ name: 1 }, "name"],
      [{ summary: 1 }, "summary"],
      [{ purpose: null }, "purpose"],
      [{ layer: "galaxy" }, "layer"],
      [{ status: "ready" }, "status"],
      [{ kind: 5 }, "kind"],
      [{ parent: 5 }, "parent"],
      [{ anchors: "x" }, "anchors"],
      [{ columns: {} }, "columns"],
      [{ columns: [1] }, "columns"],
      [{ columns: [{ name: "a", type: "t", pk: "yes" }] }, "columns"],
      [{ columns: [{ name: 5, type: "t" }] }, "columns"],
      [{ indexes: "x" }, "indexes"],
      [{ indexes: [{ columns: "a" }] }, "indexes"],
    ];
    for (const [body, field] of cases) assert.deepEqual(fieldsOf(() => nodeInput(body)), [field], JSON.stringify(body));
  });
  test("a column list and an index list pass through in their cleaned shape", () => {
    const out = nodeInput({ columns: [{ name: "id", type: "uuid", pk: true }], indexes: [{ columns: ["id"], unique: true, name: "pk", extra: 1 }] });
    assert.deepEqual(out.columns, [{ name: "id", type: "uuid", pk: true }]);
    assert.deepEqual(out.indexes, [{ columns: ["id"], unique: true, name: "pk" }]);
  });
  test("too long a text, and too many columns, are refused", () => {
    assert.deepEqual(fieldsOf(() => nodeInput({ name: "x".repeat(201) })), ["name"]);
    assert.deepEqual(fieldsOf(() => nodeInput({ columns: Array.from({ length: 501 }, () => ({ name: "a", type: "t" })) })), ["columns"]);
  });
});

describe("layoutInput", () => {
  test("positions with optional sizes, and optional placed", () => {
    assert.deepEqual(layoutInput({ positions: [{ id: "a", x: 1, y: 2 }, { id: "b", x: 3, y: 4, width: 5, height: 6 }], placed: false }), {
      positions: [{ id: "a", x: 1, y: 2 }, { id: "b", x: 3, y: 4, width: 5, height: 6 }],
      placed: false,
    });
  });
  test("an empty, oversized or malformed list is refused", () => {
    for (const b of [{}, { positions: [] }, { positions: "x" }, { positions: Array.from({ length: 2001 }, () => ({ id: "a", x: 1, y: 1 })) }, { positions: [null] }, { positions: [{ x: 1, y: 1 }] }, { positions: [{ id: "a", x: "1", y: 1 }] }, { positions: [{ id: "a", x: 1, y: NaN }] }, { positions: [{ id: "a", x: 1, y: 1, width: "w" }] }, { positions: [{ id: "a", x: 1, y: 1 }], placed: 1 }]) {
      assert.deepEqual(fieldsOf(() => layoutInput(b as Record<string, unknown>)).length > 0, true, JSON.stringify(b).slice(0, 60));
    }
  });
});
