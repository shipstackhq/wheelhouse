/**
 * The Lexical side of rich-text editing for Markdown fields (ticket descriptions).
 *
 * Markdown stays the stored format: agents read and write it over MCP, so the editor
 * must hand back text that means the same thing. Lexical's Markdown export is close,
 * but it backslash-escapes `_`, `~` and `*` wherever they appear in plain text, which
 * would turn `get_ticket_context` into `get\_ticket\_context` in every ticket someone
 * edits. `unescapeHarmless` undoes only the escapes that can't change the meaning.
 */
import { $convertFromMarkdownString, $convertToMarkdownString, TRANSFORMERS } from "@lexical/markdown";
import { CodeHighlightNode, CodeNode } from "@lexical/code";
import { AutoLinkNode, LinkNode } from "@lexical/link";
import { ListItemNode, ListNode } from "@lexical/list";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { TableCellNode, TableNode, TableRowNode } from "@lexical/table";

export const EDITOR_NODES = [HeadingNode, QuoteNode, ListNode, ListItemNode, CodeNode, CodeHighlightNode, LinkNode, AutoLinkNode, TableNode, TableRowNode, TableCellNode];
export const MD_TRANSFORMERS = TRANSFORMERS;

/** Run inside `editor.update`: replace the editor's content with this Markdown. */
export const $markdownToEditor = (md: string) => $convertFromMarkdownString(md, MD_TRANSFORMERS, undefined, false);
/** Run inside `editor.read` / `editor.update`: the editor's content as Markdown, with harmless escapes undone. */
export const $editorToMarkdown = () => unescapeHarmless($convertToMarkdownString(MD_TRANSFORMERS, undefined, false));

/**
 * Undo the escapes Lexical adds that cannot matter:
 * - an underscore between two word characters (snake_case never starts emphasis),
 * - a single tilde (only `~~` is strikethrough),
 * - an asterisk with whitespace on both sides (it cannot open or close emphasis).
 * Fenced code and inline code are left exactly as they are.
 */
export function unescapeHarmless(md: string): string {
  const fixText = (s: string) => s.replace(/(\w)\\_(?=\w)/g, "$1_").replace(/(?<!~|~\\)\\~(?!\\?~)/g, "~").replace(/(?<=\s)\\\*(?=\s)/g, "*");
  let inFence = false;
  return md
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      // keep inline code spans untouched: only the text between them is fixed
      return line
        .split(/(`+[^`]*`+)/)
        .map((part, i) => (i % 2 === 1 ? part : fixText(part)))
        .join("");
    })
    .join("\n");
}
