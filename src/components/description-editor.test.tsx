import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { DescriptionEditor } from "./description-editor";

const visible = (html: string) => html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");

test("the description editor offers rich text and raw Markdown, with rich text selected by default", () => {
  const html = renderToStaticMarkup(<DescriptionEditor value={"## Why\n\n- one\n- two"} onChange={() => {}} />);
  assert.match(html, /role="group"[^>]*aria-label="Editor type"/);
  assert.ok(visible(html).includes("Rich text") && visible(html).includes("Markdown"));
  assert.match(html, /aria-pressed="true"[^>]*>Rich text</);
  assert.match(html, /aria-pressed="false"[^>]*>Markdown</);
  assert.ok(!html.includes("<textarea"), "raw Markdown is only shown when asked for");
});

test("the editor itself is loaded on demand: the page renders a placeholder, not the editor", () => {
  const html = renderToStaticMarkup(<DescriptionEditor value="" onChange={() => {}} />);
  assert.ok(html.includes("aria-busy") && !html.includes('role="toolbar"'));
});
