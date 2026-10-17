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
  for (const label of ["Bold", "Italic", "Strikethrough", "Inline code", "Text style", "Numbered list", "Bulleted list", "Task list", "Decrease indent", "Increase indent", "Link", "Image", "Table", "Divider", "Clear formatting", "Undo", "Redo", "Full screen"])
    assert.ok(html.includes(`aria-label="${label}"`), `${label} button`);
});

test("the text style menu starts at Paragraph, and Markdown view appears only when the caller offers it", () => {
  const plain = renderToStaticMarkup(<RichMarkdownEditor value="" onChange={() => {}} />);
  assert.match(plain, /aria-label="Text style"[^>]*>.*Paragraph/s);
  assert.ok(!plain.includes('aria-label="Markdown view"'));
  const withSource = renderToStaticMarkup(<RichMarkdownEditor value="" onChange={() => {}} onShowMarkdown={() => {}} />);
  assert.ok(withSource.includes('aria-label="Markdown view"'));
});

test("nothing Markdown cannot store is offered (fonts, colours, alignment, underline)", () => {
  const html = renderToStaticMarkup(<RichMarkdownEditor value="" onChange={() => {}} />);
  for (const label of ["Underline", "Font", "Font size", "Text color", "Highlight", "Align"]) assert.ok(!html.includes(`aria-label="${label}"`), label);
});
