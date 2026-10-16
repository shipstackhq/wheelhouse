import { test } from "vitest";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { LabelsInput } from "./labels-input";

const visible = (html: string) => html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");

test("labels show as pills, one per label, not as a comma-separated string", () => {
  const html = renderToStaticMarkup(<LabelsInput value="bug, frontend, phase-2" onCommit={() => {}} />);
  const text = visible(html);
  for (const l of ["bug", "frontend", "phase-2"]) assert.ok(text.includes(l), l);
  assert.ok(!text.includes("bug, frontend"), "no comma-separated text on screen");
  assert.equal(html.split('aria-label="Remove label').length - 1, 3, "a remove button per pill");
});

test("each pill's remove button says which label it removes", () => {
  const html = renderToStaticMarkup(<LabelsInput value="bug, ui" onCommit={() => {}} />);
  assert.ok(html.includes('aria-label="Remove label bug"') && html.includes('aria-label="Remove label ui"'));
});

test("duplicates and stray commas in the saved string show once and cleanly", () => {
  const html = renderToStaticMarkup(<LabelsInput value=" bug,, Bug , ui," onCommit={() => {}} />);
  assert.equal(html.split('aria-label="Remove label').length - 1, 2);
});

test("there is always an input to add another, with a hint when there are no labels yet", () => {
  const some = renderToStaticMarkup(<LabelsInput value="bug" onCommit={() => {}} />);
  assert.ok(some.includes('aria-label="Add a label"') && some.includes('placeholder="Add label…"'));
  const none = renderToStaticMarkup(<LabelsInput value="" onCommit={() => {}} />);
  assert.ok(none.includes('placeholder="bug, frontend…"') && !none.includes("Remove label"));
});

test("the field is just the pills and the input: no background, border or padding of its own", () => {
  const html = renderToStaticMarkup(<LabelsInput value="bug" onCommit={() => {}} />);
  const box = html.match(/^<div class="([^"]*)"/)![1];
  for (const pattern of [/\bbg-/, /\bborder/, /\bp[xytblr]?-\d/, /\brounded/, /focus-within:/])
    assert.ok(!pattern.test(box), `container has no ${pattern} (got: ${box})`);
});
