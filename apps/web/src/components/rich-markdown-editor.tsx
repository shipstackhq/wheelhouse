import { useEffect, useState } from "react";
import clsx from "clsx";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { CheckListPlugin } from "@lexical/react/LexicalCheckListPlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { AutoFocusPlugin } from "@lexical/react/LexicalAutoFocusPlugin";
import { TabIndentationPlugin } from "@lexical/react/LexicalTabIndentationPlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createHeadingNode, $createQuoteNode, $isHeadingNode, $isQuoteNode, type HeadingTagType } from "@lexical/rich-text";
import { $createCodeNode, $isCodeNode } from "@lexical/code";
import { INSERT_CHECK_LIST_COMMAND, INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND, $isListNode, ListNode } from "@lexical/list";
import { TOGGLE_LINK_COMMAND } from "@lexical/link";
import { $setBlocksType } from "@lexical/selection";
import { $getSelection, $createParagraphNode, $isRangeSelection, FORMAT_TEXT_COMMAND, SELECTION_CHANGE_COMMAND, COMMAND_PRIORITY_LOW, type ElementNode, type TextFormatType } from "lexical";
import { $getNearestNodeOfType } from "@lexical/utils";
import { $editorToMarkdown, $markdownToEditor, EDITOR_NODES, MD_TRANSFORMERS } from "../lib/markdown-editor";

type Block = "paragraph" | "h1" | "h2" | "h3" | "quote" | "code" | "bullet" | "number" | "check";

/**
 * A rich-text editor for a Markdown string. Markdown stays the stored format: `onChange` only fires after
 * the person edits (never on load), so opening and saving an untouched description writes back exactly what was there.
 */
export function RichMarkdownEditor({
  value,
  onChange,
  autoFocus = true,
  className,
  minHeight = "min-h-48",
  maxHeight = "max-h-[50vh]",
}: {
  value: string;
  onChange: (markdown: string) => void;
  autoFocus?: boolean;
  className?: string;
  /** Tailwind min-height class for the editable area — widen for long-form content (e.g. docs) vs. the default ticket-description sizing. */
  minHeight?: string;
  /** Tailwind max-height class for the editable area (controls scroll). */
  maxHeight?: string;
}) {
  return (
    <LexicalComposer
      initialConfig={{
        namespace: "wheelhouse-markdown",
        nodes: EDITOR_NODES,
        editorState: () => $markdownToEditor(value),
        onError: (e) => console.error("[rich editor]", e),
        theme: { text: { code: "rounded bg-bg px-1 py-0.5 font-mono text-[12px]" }, link: "text-accent underline" },
      }}
    >
      <div className={clsx("overflow-hidden bg-panel", className)}>
        <Toolbar />
        <div className="relative">
          <RichTextPlugin
            contentEditable={<ContentEditable aria-label="Description" className={clsx("md overflow-y-auto px-3 py-2 outline-none", maxHeight, minHeight)} />}
            placeholder={null}
            ErrorBoundary={LexicalErrorBoundary}
          />
        </div>
      </div>
      <HistoryPlugin />
      <ListPlugin />
      <CheckListPlugin />
      <LinkPlugin />
      <TabIndentationPlugin />
      <MarkdownShortcutPlugin transformers={MD_TRANSFORMERS} />
      {autoFocus && <AutoFocusPlugin />}
      <OnChangePlugin
        ignoreSelectionChange
        onChange={(state) => state.read(() => onChange($editorToMarkdown()))}
      />
    </LexicalComposer>
  );
}

function Toolbar() {
  const [editor] = useLexicalComposerContext();
  const [block, setBlock] = useState<Block>("paragraph");
  const [marks, setMarks] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const read = () => {
      const sel = $getSelection();
      if (!$isRangeSelection(sel)) return;
      setMarks({ bold: sel.hasFormat("bold"), italic: sel.hasFormat("italic"), strikethrough: sel.hasFormat("strikethrough"), code: sel.hasFormat("code") });
      const top = sel.anchor.getNode().getTopLevelElementOrThrow();
      if ($isListNode(top) || $getNearestNodeOfType(sel.anchor.getNode(), ListNode)) {
        const list = $getNearestNodeOfType(sel.anchor.getNode(), ListNode);
        const t = list?.getListType();
        setBlock(t === "check" ? "check" : t === "number" ? "number" : "bullet");
      } else if ($isHeadingNode(top)) setBlock(top.getTag() as Block);
      else if ($isQuoteNode(top)) setBlock("quote");
      else if ($isCodeNode(top)) setBlock("code");
      else setBlock("paragraph");
    };
    const off = editor.registerUpdateListener(({ editorState }) => editorState.read(read));
    const off2 = editor.registerCommand(SELECTION_CHANGE_COMMAND, () => (editor.getEditorState().read(read), false), COMMAND_PRIORITY_LOW);
    return () => (off(), off2());
  }, [editor]);

  const format = (f: TextFormatType) => editor.dispatchCommand(FORMAT_TEXT_COMMAND, f);
  const setType = (make: () => ElementNode) =>
    editor.update(() => {
      const sel = $getSelection();
      if ($isRangeSelection(sel)) $setBlocksType(sel, make);
    });
  const heading = (tag: HeadingTagType) => setType(() => (block === tag ? $createParagraphNode() : $createHeadingNode(tag)));
  const list = (cmd: typeof INSERT_UNORDERED_LIST_COMMAND, kind: Block) => (block === kind ? setType($createParagraphNode) : editor.dispatchCommand(cmd, undefined));

  const btn = (label: string, title: string, active: boolean, onClick: () => void) => (
    <button
      type="button"
      key={title}
      title={title}
      aria-label={title}
      aria-pressed={active}
      // keep the selection in the editor when a toolbar button is pressed
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={clsx("min-w-7 rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-accent/10 hover:text-accent", active ? "bg-accent/15 text-accent" : "text-muted")}
    >
      {label}
    </button>
  );
  const sep = (k: string) => <span key={k} className="mx-1 h-4 w-px bg-line/60" aria-hidden />;

  return (
    <div role="toolbar" aria-label="Formatting" className="sticky top-0 z-10 flex flex-wrap items-center gap-0.5 rounded-t-md border-b border-line/60 bg-panel/90 px-2 py-1.5 backdrop-blur-sm">
      {btn("B", "Bold", !!marks.bold, () => format("bold"))}
      {btn("I", "Italic", !!marks.italic, () => format("italic"))}
      {btn("S", "Strikethrough", !!marks.strikethrough, () => format("strikethrough"))}
      {btn("</>", "Inline code", !!marks.code, () => format("code"))}
      {sep("1")}
      {btn("H1", "Heading 1", block === "h1", () => heading("h1"))}
      {btn("H2", "Heading 2", block === "h2", () => heading("h2"))}
      {btn("H3", "Heading 3", block === "h3", () => heading("h3"))}
      {sep("2")}
      {btn("• List", "Bulleted list", block === "bullet", () => list(INSERT_UNORDERED_LIST_COMMAND, "bullet"))}
      {btn("1. List", "Numbered list", block === "number", () => list(INSERT_ORDERED_LIST_COMMAND, "number"))}
      {btn("☑ Tasks", "Task list", block === "check", () => list(INSERT_CHECK_LIST_COMMAND, "check"))}
      {sep("3")}
      {btn("❝", "Quote", block === "quote", () => setType(() => (block === "quote" ? $createParagraphNode() : $createQuoteNode())))}
      {btn("{ }", "Code block", block === "code", () => setType(() => (block === "code" ? $createParagraphNode() : $createCodeNode())))}
      {btn("Link", "Link", false, () => {
        const url = window.prompt("Link address (leave empty to remove the link)");
        if (url === null) return;
        editor.dispatchCommand(TOGGLE_LINK_COMMAND, url.trim() || null);
      })}
    </div>
  );
}
