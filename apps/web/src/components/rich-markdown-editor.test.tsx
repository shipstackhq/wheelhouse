import { test } from "vitest";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { RichMarkdownEditor } from "./rich-markdown-editor";

test("the rich editor is a labelled text box with a labelled formatting toolbar", () => {
  const html = renderToStaticMarkup(<RichMarkdownEditor value={"## Why\n\n- one"} onChange={() => {}} />);
  assert.match(html, /contentEditable="true"[^>]*role="textbox"|aria-label="Description"[^>]*contentEditable="true"/);
  assert.match(html, /role="toolbar"[^>]*aria-label="Formatting"/);
});

test("the toolbar offers the formatting people reach for, each labelled for screen readers", () => {
  const html = renderToStaticMarkup(<RichMarkdownEditor value="" onChange={() => {}} />);
  for (const label of ["Bold", "Italic", "Strikethrough", "Inline code", "Heading 1", "Heading 2", "Heading 3", "Bulleted list", "Numbered list", "Task list", "Quote", "Code block", "Link"])
    assert.ok(html.includes(`aria-label="${label}"`), `${label} button`);
});
