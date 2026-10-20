import { test } from "vitest";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { AutoGrowTextarea } from "./auto-grow-textarea";

test("the field wraps long text instead of scrolling: one row to start, no manual resize handle, no scrollbar", () => {
  const html = renderToStaticMarkup(<AutoGrowTextarea value="A very long issue title that will need several lines on a narrow screen" onChange={() => {}} />);
  assert.match(html, /^<textarea /);
  assert.ok(html.includes('rows="1"'));
  for (const cls of ["resize-none", "overflow-hidden", "whitespace-pre-wrap", "break-words", "w-full"]) assert.ok(html.includes(cls), cls);
  assert.ok(html.includes("A very long issue title that will need several lines"), "the whole text is in the field");
});

test("caller classes and attributes are kept", () => {
  const html = renderToStaticMarkup(<AutoGrowTextarea id="issue-title" aria-label="Title" className="text-xl font-semibold" value="x" onChange={() => {}} />);
  assert.ok(html.includes('id="issue-title"') && html.includes('aria-label="Title"') && html.includes("text-xl font-semibold"));
});
