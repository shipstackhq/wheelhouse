import { test } from "node:test";
import assert from "node:assert/strict";
import { addLabels, applyKey, applyText, formatLabels, parseLabels, removeLabel, settle } from "./labels";

test("a comma-separated string is the stored form: parsing trims, drops empties and duplicates", () => {
  assert.deepEqual(parseLabels("bug, frontend"), ["bug", "frontend"]);
  assert.deepEqual(parseLabels("  a ,, b ,  "), ["a", "b"]);
  assert.deepEqual(parseLabels("Bug, bug, BUG, ui"), ["Bug", "ui"], "case-insensitive duplicates keep the first spelling");
  assert.deepEqual(parseLabels(""), []);
  assert.deepEqual(parseLabels("a\nb"), ["a", "b"], "a pasted list one per line works too");
});

test("formatting is the inverse for ordinary labels, so what the UI shows round-trips through the string", () => {
  for (const s of ["", "bug", "bug, frontend, phase-2"]) assert.equal(formatLabels(parseLabels(s)), s);
});

test("adding takes one label or several, and skips ones already there", () => {
  assert.deepEqual(addLabels(["bug"], "ui"), ["bug", "ui"]);
  assert.deepEqual(addLabels(["bug"], "UI, bug, api"), ["bug", "UI", "api"]);
  assert.deepEqual(addLabels(["bug"], "  "), ["bug"]);
});

test("removing is case-insensitive and leaves the order alone", () => {
  assert.deepEqual(removeLabel(["a", "B", "c"], "b"), ["a", "c"]);
  assert.deepEqual(removeLabel(["a"], "z"), ["a"]);
});

test("typing a comma finishes a label; the rest stays in the box", () => {
  assert.deepEqual(applyText({ labels: [], text: "" }, "bug"), { labels: [], text: "bug" });
  assert.deepEqual(applyText({ labels: [], text: "bug" }, "bug,"), { labels: ["bug"], text: "" });
  assert.deepEqual(applyText({ labels: ["x"], text: "" }, "a, b, c"), { labels: ["x", "a", "b"], text: "c" }, "a paste of several");
});

test("Enter or comma turns the typed text into a label; with nothing typed they do nothing", () => {
  assert.deepEqual(applyKey({ labels: ["a"], text: "b" }, "Enter"), { labels: ["a", "b"], text: "", prevent: true });
  assert.deepEqual(applyKey({ labels: ["a"], text: "b" }, ","), { labels: ["a", "b"], text: "", prevent: true });
  assert.deepEqual(applyKey({ labels: ["a"], text: "  " }, "Enter"), { labels: ["a"], text: "", prevent: true });
  assert.equal(applyKey({ labels: [], text: "" }, ",").prevent, true, "no empty label from a stray comma");
});

test("Backspace in an empty box removes the last label; in a box with text it just deletes a character", () => {
  assert.deepEqual(applyKey({ labels: ["a", "b"], text: "" }, "Backspace"), { labels: ["a"], text: "", prevent: true });
  assert.equal(applyKey({ labels: ["a"], text: "x" }, "Backspace").prevent, false);
  assert.equal(applyKey({ labels: [], text: "" }, "Backspace").prevent, false);
});

test("other keys are left alone", () => {
  assert.deepEqual(applyKey({ labels: ["a"], text: "b" }, "x"), { labels: ["a"], text: "b", prevent: false });
});

test("leaving the field turns pending text into a label", () => {
  assert.deepEqual(settle({ labels: ["a"], text: "b" }), ["a", "b"]);
  assert.deepEqual(settle({ labels: ["a"], text: " " }), ["a"]);
  assert.deepEqual(settle({ labels: ["a"], text: "A" }), ["a"], "a duplicate is not added twice");
});
