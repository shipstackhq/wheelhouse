import { test } from "vitest";
import assert from "node:assert/strict";
import { arrowStep, isDirty, neighbours, parseIssueParam, singleLine, usesArrowKeys } from "./issue-nav";

test("?t= accepts a team key and number, upper-cases the key, and ignores anything else", () => {
  assert.equal(parseIssueParam("WH-49"), "WH-49");
  assert.equal(parseIssueParam(" wh-7 "), "WH-7");
  assert.equal(parseIssueParam("AB12-3"), "AB12-3");
  for (const bad of [null, undefined, "", "WH", "WH-", "-4", "WH-4a", "WH-1 2", "W H-1", "../etc", "WH-1;DROP", "1WH-2", "WH-12345678901"])
    assert.equal(parseIssueParam(bad), null, `${JSON.stringify(bad)} is not an issue`);
});

test("previous and next follow the column's order and stop at the ends", () => {
  const refs = ["WH-3", "WH-9", "WH-4"];
  assert.deepEqual(neighbours(refs, "WH-9"), { index: 1, total: 3, prev: "WH-3", next: "WH-4" });
  assert.deepEqual(neighbours(refs, "WH-3"), { index: 0, total: 3, prev: null, next: "WH-9" });
  assert.deepEqual(neighbours(refs, "WH-4"), { index: 2, total: 3, prev: "WH-9", next: null });
});

test("an issue that isn't in the list, or a list of one, has nowhere to go", () => {
  assert.deepEqual(neighbours(["WH-1", "WH-2"], "WH-9"), { index: -1, total: 2, prev: null, next: null });
  assert.deepEqual(neighbours(["WH-1"], "WH-1"), { index: 0, total: 1, prev: null, next: null });
  assert.deepEqual(neighbours([], "WH-1"), { index: -1, total: 0, prev: null, next: null });
});

const clean = { editingBody: false, body: "", savedBody: "text", comment: "", title: "T", savedTitle: "T" };

test("nothing typed means nothing to lose", () => {
  assert.equal(isDirty(clean), false);
  assert.equal(isDirty({ ...clean, comment: "   \n " }), false, "a blank comment box is not a draft");
});

test("an unsaved description, comment or title edit counts as a draft", () => {
  assert.equal(isDirty({ ...clean, editingBody: true, body: "text changed", savedBody: "text" }), true);
  assert.equal(isDirty({ ...clean, comment: "looks good" }), true);
  assert.equal(isDirty({ ...clean, title: "T renamed" }), true);
});

test("opening the editor without changing anything isn't a draft, and a stale body outside edit mode is ignored", () => {
  assert.equal(isDirty({ ...clean, editingBody: true, body: "text", savedBody: "text" }), false);
  assert.equal(isDirty({ ...clean, editingBody: false, body: "leftover", savedBody: "text" }), false);
});

const el = (tag: string, extra: Record<string, unknown> = {}) => ({ tagName: tag, ...extra });

test("text fields, selects, menus and the confirmation keep their own arrow keys", () => {
  for (const t of ["INPUT", "TEXTAREA", "SELECT", "input"]) assert.equal(usesArrowKeys(el(t)), true);
  assert.equal(usesArrowKeys(el("DIV", { isContentEditable: true })), true);
  assert.equal(usesArrowKeys(el("DIV", { closest: (s: string) => (s.includes('[role="listbox"]') ? {} : null) })), true, "inside an open select list");
  assert.equal(usesArrowKeys(el("DIV", { closest: () => null })), false);
  assert.equal(usesArrowKeys(el("BUTTON")), false);
  assert.equal(usesArrowKeys(null), false);
});

test("left and right move between issues; other keys, modifiers and typing do not", () => {
  const press = (over: Record<string, unknown>) => arrowStep({ key: "ArrowRight", target: el("DIV"), ...over });
  assert.equal(press({}), 1);
  assert.equal(press({ key: "ArrowLeft" }), -1);
  for (const key of ["ArrowUp", "ArrowDown", "Enter", "j", "Escape"]) assert.equal(press({ key }), 0, `${key} is left alone`);
  for (const mod of ["altKey", "ctrlKey", "metaKey", "shiftKey"]) assert.equal(press({ [mod]: true }), 0, `${mod} is left to the browser`);
  assert.equal(press({ target: el("TEXTAREA") }), 0, "typing a comment");
  assert.equal(press({ defaultPrevented: true }), 0);
  assert.equal(press({ isComposing: true }), 0, "an input method is composing");
});

test("a title never contains a line break: pasted ones become one space, and ordinary spacing is left alone", () => {
  assert.equal(singleLine("one\ntwo"), "one two");
  assert.equal(singleLine("one \r\n  two\n\nthree"), "one two three");
  assert.equal(singleLine("already  one line"), "already  one line");
  assert.equal(singleLine(""), "");
});

test("label edits that have not been saved yet count as a draft too", () => {
  assert.equal(isDirty({ ...clean, labelsPending: true }), true);
  assert.equal(isDirty({ ...clean, labelsPending: false }), false);
  assert.equal(isDirty({ ...clean, subIssueDraft: true }), true); // a sub-issue title typed and not added
  assert.equal(isDirty({ ...clean, subIssueDraft: false }), false);
});
