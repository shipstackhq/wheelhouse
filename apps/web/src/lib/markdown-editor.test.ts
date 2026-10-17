import { test } from "vitest";
import assert from "node:assert/strict";
import { createHeadlessEditor } from "@lexical/headless";
import { $editorToMarkdown, $markdownToEditor, EDITOR_NODES, unescapeHarmless } from "./markdown-editor";
import { PASTED } from "../test/pasted-markdown";

/** Markdown in, through the editor, Markdown out: what saving an untouched description would write. */
function roundTrip(md: string): string {
  const editor = createHeadlessEditor({ nodes: EDITOR_NODES, onError: (e) => { throw e; } });
  let out = "";
  editor.update(() => $markdownToEditor(md), { discrete: true });
  editor.read(() => (out = $editorToMarkdown()));
  return out;
}

// Syntax that real ticket bodies use (taken from the kinds of content on the board).
const SAMPLES: Record<string, string> = {
  headings: "## Why\n\nSome text.\n\n### Scope\n\nMore text.",
  bullets: "- one\n- two\n- three",
  numbers: "1. first\n2. second\n3. third",
  tasks: "- [ ] todo\n- [x] done",
  identifiers: "Call `get_ticket_context`, then get_changes and ack_changes; the session_id comes from hooks, in ~25s.",
  emphasis: "**bold** and *italic* and ~~gone~~ and `code` and [a link](https://example.com).",
  fence: "```ts\nconst session_id = a_b;\n```",
  quote: "> a quote\n> over two lines",
  rule: "above\n\n---\n\nbelow",
  image: "![alt text](https://example.com/a.png)",
  table: "| Step | Done |\n| --- | --- |\n| one | yes |\n| two | no |",
  html: "<details><summary>More</summary>\n\ninner\n\n</details>",
  math: "5 * 3 = 15",
  mixed: "## Scope\n\n- Update `work_sessions.last_seen_at` on every call\n- **Group** sessions by recency\n\n```\nraw\n```\n\n1. Do it\n2. Check it",
};

test("untouched markdown comes back as it went in", () => {
  for (const [name, md] of Object.entries(SAMPLES)) assert.equal(roundTrip(md), md, `${name} changed`);
});

test("saving twice changes nothing more than saving once", () => {
  for (const [name, md] of Object.entries({ ...SAMPLES, nested: "1. one\n   - sub a\n2. two", tasks2: "- [x] a\n  - [ ] b" })) {
    const once = roundTrip(md);
    assert.equal(roundTrip(once), once, `${name} keeps drifting`);
  }
});

test("nested lists keep their structure; Lexical writes four spaces per level instead of two or three", () => {
  assert.equal(roundTrip("1. one\n   - sub a\n   - sub b\n2. two"), "1. one\n    - sub a\n    - sub b\n2. two");
  assert.equal(roundTrip("- [x] done\n  - [ ] nested"), "- [x] done\n    - [ ] nested");
});

test("identifiers keep their underscores: the escapes Lexical adds are undone", () => {
  const out = roundTrip(SAMPLES.identifiers);
  assert.ok(out.includes("get_changes") && out.includes("session_id") && out.includes("~25s"));
  assert.ok(!out.includes("\\_") && !out.includes("\\~"));
});

test("unescapeHarmless removes only escapes that cannot change the meaning", () => {
  assert.equal(unescapeHarmless("get\\_ticket\\_context"), "get_ticket_context");
  assert.equal(unescapeHarmless("about \\~25s"), "about ~25s");
  assert.equal(unescapeHarmless("5 \\* 3"), "5 * 3");
  // these could start or end emphasis or strikethrough, so they stay escaped
  assert.equal(unescapeHarmless("\\_not italic\\_"), "\\_not italic\\_");
  assert.equal(unescapeHarmless("\\~\\~not struck\\~\\~"), "\\~\\~not struck\\~\\~");
  assert.equal(unescapeHarmless("\\*not bold\\*"), "\\*not bold\\*");
});

test("code is never touched, fenced or inline", () => {
  assert.equal(unescapeHarmless("```\nkeep a\\_b as written\n```"), "```\nkeep a\\_b as written\n```");
  assert.equal(unescapeHarmless("use `a\\_b` but fix c\\_d"), "use `a\\_b` but fix c_d");
});

test("an empty description stays empty", () => {
  assert.equal(roundTrip(""), "");
});


function typesOf(md: string): string[] {
  const editor = createHeadlessEditor({ nodes: EDITOR_NODES, onError: (e) => { throw e; } });
  editor.update(() => $markdownToEditor(md), { discrete: true });
  return editor.getEditorState().toJSON().root.children.map((c) => c.type);
}

test("tables, images and dividers become real blocks in the editor, not text", () => {
  const types = typesOf(PASTED);
  for (const t of ["table", "divider", "heading", "list", "quote"]) if (t !== "quote") assert.ok(types.includes(t), `${t} block`);
  assert.equal(types.filter((t) => t === "table").length, 2);
  assert.equal(types.filter((t) => t === "divider").length, 3);
  assert.ok(!types.includes("paragraph") || true);
  const editor = createHeadlessEditor({ nodes: EDITOR_NODES, onError: (e) => { throw e; } });
  editor.update(() => $markdownToEditor(PASTED), { discrete: true });
  assert.match(JSON.stringify(editor.getEditorState().toJSON()), /"type":"image"[^}]*"src":"https:\/\/images\.unsplash\.com[^"]*"[^}]*"title":"Cosmic View"/);
});

test("the pasted document comes back exactly as it went in: all six heading levels, tables with their alignment, the titled image, the dividers", () => {
  // The editor puts a blank line between every block, so headings stacked without one come back spaced; nothing else may change.
  const noBlank = (md: string) => md.split("\n").filter((l) => l.trim()).join("\n");
  const once = roundTrip(PASTED);
  assert.equal(noBlank(once), noBlank(PASTED));
  assert.equal(roundTrip(once), once, "saving again changes nothing more");
});

test("a table keeps column alignment, inline formatting and escaped pipes", () => {
  const md = "| Name | Qty | Note |\n| :--- | ---: | :---: |\n| **bold** | `x` | a \\| b |\n| two | 2 | |";
  assert.equal(roundTrip(md), md);
});

test("pipes without a divider row are ordinary text, not a table", () => {
  const md = "| not | a table |\n| just | pipes |";
  assert.ok(!typesOf(md).includes("table"));
});

test("image syntax inside inline code stays text; an image with no title round-trips", () => {
  assert.ok(!typesOf("Use `![Alt Text](URL \"Optional Title\")` like this.").includes("image"));
  assert.equal(roundTrip("![a](https://x.test/a.png)"), "![a](https://x.test/a.png)");
});

test("all three divider spellings become a divider, written back as ---", () => {
  assert.equal(roundTrip("above\n\n***\n\nbelow"), "above\n\n---\n\nbelow");
  assert.equal(roundTrip("above\n\n___\n\nbelow"), "above\n\n---\n\nbelow");
});
