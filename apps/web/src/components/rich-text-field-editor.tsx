import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
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
import { TablePlugin } from "@lexical/react/LexicalTablePlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createHeadingNode, $createQuoteNode, $isHeadingNode, $isQuoteNode, type HeadingTagType } from "@lexical/rich-text";
import { $createCodeNode } from "@lexical/code";
import { $isListNode, INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND, INSERT_CHECK_LIST_COMMAND } from "@lexical/list";
import { $isLinkNode, TOGGLE_LINK_COMMAND } from "@lexical/link";
import { $setBlocksType } from "@lexical/selection";
import { $insertNodeToNearestRoot, mergeRegister } from "@lexical/utils";
import {
  $createParagraphNode,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  FORMAT_TEXT_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  type ElementNode,
  type LexicalEditor,
  type TextFormatType,
} from "lexical";
import { $editorToMarkdown, $markdownToEditor, EDITOR_NODES, MD_TRANSFORMERS } from "../lib/markdown-editor";
import { $createDividerNode } from "../lib/md-blocks";
import { BoldIcon, BulletListIcon, CodeBlockIcon, DividerIcon, Heading1Icon, Heading2Icon, Heading3Icon, InlineCodeIcon, ItalicIcon, LinkIcon, NumberedListIcon, ParagraphIcon, QuoteIcon, StrikethroughIcon, TaskListIcon } from "./icons";
import { EDITOR_THEME } from "./rich-markdown-editor";

/**
 * The Lexical half of `RichTextField`, loaded only when someone starts editing. The text reads like plain text: no toolbar, no
 * background. Selecting text opens a small tooltip to format it, and `/` opens a menu of styles. Markdown is what it hands back.
 */
export function RichTextFieldEditor({
  value,
  label,
  placeholder,
  className,
  onEdit,
  onExit,
}: {
  /** The Markdown the editor starts from. */
  value: string;
  label: string;
  placeholder?: string;
  className?: string;
  /** Every edit, as Markdown. Not called for the text the editor opens with. */
  onEdit: (markdown: string) => void;
  /** Editing is over: focus left the field, or Escape with no menu open. */
  onExit: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  return (
    <LexicalComposer
      initialConfig={{
        namespace: "wheelhouse-rich-text-field",
        nodes: EDITOR_NODES,
        editorState: () => $markdownToEditor(value),
        onError: (e: Error) => console.error("[rich text field]", e),
        theme: EDITOR_THEME,
      }}
    >
      <div
        ref={rootRef}
        className={clsx("relative", className)}
        onBlur={(e) => {
          // Focus moving into the tooltip or the menu (both portalled out of this element) is still editing.
          const next = e.relatedTarget;
          if (next instanceof Element && next.closest("[data-rich-text-overlay]")) return;
          if (next && rootRef.current?.contains(next)) return;
          onExit();
        }}
      >
        <RichTextPlugin
          contentEditable={<ContentEditable aria-label={label} aria-multiline="true" role="textbox" className="md min-h-6 outline-none" />}
          placeholder={placeholder ? <div className="pointer-events-none absolute inset-x-0 top-0 text-muted">{placeholder}</div> : null}
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <ListPlugin />
        <CheckListPlugin />
        <LinkPlugin />
        <TablePlugin />
        <MarkdownShortcutPlugin transformers={MD_TRANSFORMERS} />
        <SelectionTooltip />
        <SlashMenu onExit={onExit} />
      </div>
      <AutoFocusPlugin />
      <OnChangePlugin ignoreSelectionChange onChange={(state) => state.read(() => onEdit($editorToMarkdown()))} />
    </LexicalComposer>
  );
}

// ───────── the selection tooltip ─────────

type Marks = Record<"bold" | "italic" | "strikethrough" | "code", boolean>;
/** `list` is the list type the caret's block is in ("" for none). */
type Tooltip = { x: number; y: number; below: boolean; marks: Marks; heading: string; quote: boolean; list: string; inLink: boolean };

/** Where the selection is on screen, or null when it is empty or not in the editor. */
function selectionRect(editor: LexicalEditor): DOMRect | null {
  const dom = window.getSelection();
  const root = editor.getRootElement();
  if (!dom || dom.rangeCount === 0 || dom.isCollapsed || !root?.contains(dom.anchorNode)) return null;
  return dom.getRangeAt(0).getBoundingClientRect();
}

/** The tooltip above a non-empty selection: the marks, the block styles and a link. */
function SelectionTooltip() {
  const [editor] = useLexicalComposerContext();
  const [tip, setTip] = useState<Tooltip | null>(null);
  const [linking, setLinking] = useState(false);
  const [url, setUrl] = useState("");
  const linkingRef = useRef(false);
  linkingRef.current = linking;

  useEffect(() => {
    // Measure the selection as it is now; the tooltip stays while its link field is open, since focus has moved into it.
    const measure = () => {
      if (linkingRef.current) return;
      const rect = selectionRect(editor);
      if (!rect) return setTip(null);
      editor.getEditorState().read(() => {
        const sel = $getSelection();
        if (!$isRangeSelection(sel)) return setTip(null);
        const top = sel.anchor.getNode().getTopLevelElementOrThrow();
        const below = rect.top < 56; // no room above: show it under the text
        setTip({
          x: rect.left + rect.width / 2,
          y: below ? rect.bottom + 8 : rect.top - 8,
          below,
          marks: { bold: sel.hasFormat("bold"), italic: sel.hasFormat("italic"), strikethrough: sel.hasFormat("strikethrough"), code: sel.hasFormat("code") },
          heading: $isHeadingNode(top) ? top.getTag() : "",
          quote: $isQuoteNode(top),
          list: $isListNode(top) ? top.getListType() : "",
          inLink: $isLinkNode(sel.anchor.getNode().getParent()) || $isLinkNode(sel.anchor.getNode()),
        });
      });
    };
    const remeasure = () => editor.getEditorState().read(measure);
    window.addEventListener("scroll", remeasure, true);
    window.addEventListener("resize", remeasure);
    return mergeRegister(
      editor.registerUpdateListener(({ editorState }) => editorState.read(measure)),
      () => {
        window.removeEventListener("scroll", remeasure, true);
        window.removeEventListener("resize", remeasure);
      },
    );
  }, [editor]);

  if (!tip) return null;
  const format = (f: TextFormatType) => editor.dispatchCommand(FORMAT_TEXT_COMMAND, f);
  const toggleBlock = (tag: HeadingTagType | "quote") =>
    editor.update(() => {
      const sel = $getSelection();
      if (!$isRangeSelection(sel)) return;
      const top = sel.anchor.getNode().getTopLevelElementOrThrow();
      const on = tag === "quote" ? $isQuoteNode(top) : $isHeadingNode(top) && top.getTag() === tag;
      const make: () => ElementNode = on ? () => $createParagraphNode() : tag === "quote" ? () => $createQuoteNode() : () => $createHeadingNode(tag);
      $setBlocksType(sel, make);
    });
  /** Makes the selected blocks a list of `kind`, or back to paragraphs when they already are that list. */
  const toggleList = (kind: "bullet" | "number") =>
    tip.list === (kind === "bullet" ? "bullet" : "number")
      ? editor.update(() => {
          const sel = $getSelection();
          if ($isRangeSelection(sel)) $setBlocksType(sel, () => $createParagraphNode());
        })
      : editor.dispatchCommand(kind === "bullet" ? INSERT_UNORDERED_LIST_COMMAND : INSERT_ORDERED_LIST_COMMAND, undefined);
  const openLink = () => {
    if (tip.inLink) return editor.dispatchCommand(TOGGLE_LINK_COMMAND, null);
    setUrl("");
    setLinking(true);
  };
  const submitLink = () => {
    const u = url.trim();
    setLinking(false);
    if (u) editor.dispatchCommand(TOGGLE_LINK_COMMAND, u);
    editor.focus();
  };
  const closeLink = () => {
    setLinking(false);
    editor.focus();
  };

  return createPortal(
    <div
      data-rich-text-overlay
      role="toolbar"
      aria-label="Format selection"
      // keep the selection in the text while the buttons are pressed; the link field is the one thing that takes focus
      onMouseDown={(e) => {
        if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
      }}
      style={{ left: tip.x, top: tip.y, transform: tip.below ? "translate(-50%, 0)" : "translate(-50%, -100%)" }}
      className="fixed z-60 flex items-center gap-0.5 rounded-md border border-line bg-panel p-1 text-muted shadow-lg"
    >
      {linking ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => (e.preventDefault(), submitLink())}
        >
          <input
            autoFocus
            type="url"
            aria-label="Link address"
            placeholder="https://"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), closeLink())}
            className="input h-7 w-56 px-2 text-sm"
          />
          <button type="submit" className="btn btn-primary h-7 px-2 text-xs" disabled={!url.trim()}>
            Apply
          </button>
        </form>
      ) : (
        <>
          <TipButton label="Bold" shortcut="⌘B" active={tip.marks.bold} onClick={() => format("bold")} icon={<BoldIcon />} />
          <TipButton label="Italic" shortcut="⌘I" active={tip.marks.italic} onClick={() => format("italic")} icon={<ItalicIcon />} />
          <TipButton label="Strikethrough" active={tip.marks.strikethrough} onClick={() => format("strikethrough")} icon={<StrikethroughIcon />} />
          <TipButton label="Inline code" active={tip.marks.code} onClick={() => format("code")} icon={<InlineCodeIcon />} />
          <Divider />
          <TipButton label="Heading 1" active={tip.heading === "h1"} onClick={() => toggleBlock("h1")} icon={<Heading1Icon />} />
          <TipButton label="Heading 2" active={tip.heading === "h2"} onClick={() => toggleBlock("h2")} icon={<Heading2Icon />} />
          <TipButton label="Heading 3" active={tip.heading === "h3"} onClick={() => toggleBlock("h3")} icon={<Heading3Icon />} />
          <TipButton label="Quote" active={tip.quote} onClick={() => toggleBlock("quote")} icon={<QuoteIcon />} />
          <TipButton label="Bulleted list" active={tip.list === "bullet"} onClick={() => toggleList("bullet")} icon={<BulletListIcon />} />
          <TipButton label="Numbered list" active={tip.list === "number"} onClick={() => toggleList("number")} icon={<NumberedListIcon />} />
          <Divider />
          <TipButton label={tip.inLink ? "Remove link" : "Link"} active={tip.inLink} onClick={openLink} icon={<LinkIcon />} />
        </>
      )}
    </div>,
    document.body,
  );
}

function TipButton({ label, shortcut, icon, active, onClick }: { label: string; shortcut?: string; icon: ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={clsx("inline-flex h-7 min-w-7 items-center justify-center rounded px-1 text-lg transition-colors hover:bg-fg/[0.07] hover:text-fg", active && "bg-fg/[0.1] text-fg")}
    >
      {icon}
    </button>
  );
}

const Divider = () => <span className="mx-0.5 h-4 w-px bg-line" aria-hidden />;

// ───────── the / menu ─────────

type SlashItem = { id: string; label: string; keywords: string; icon: ReactNode; /** Runs inside an update, with the `/` and its word already removed. */ run: (editor: LexicalEditor) => void };

/** Turn the blocks the selection is in into `make`'s block. Runs inside an update. */
const block = (make: () => ElementNode) => {
  const sel = $getSelection();
  if ($isRangeSelection(sel)) $setBlocksType(sel, make);
};

const SLASH_ITEMS: SlashItem[] = [
  { id: "text", label: "Text", keywords: "paragraph plain", icon: <ParagraphIcon />, run: () => block(() => $createParagraphNode()) },
  { id: "h1", label: "Heading 1", keywords: "title big h1", icon: <Heading1Icon />, run: () => block(() => $createHeadingNode("h1")) },
  { id: "h2", label: "Heading 2", keywords: "subtitle h2", icon: <Heading2Icon />, run: () => block(() => $createHeadingNode("h2")) },
  { id: "h3", label: "Heading 3", keywords: "small heading h3", icon: <Heading3Icon />, run: () => block(() => $createHeadingNode("h3")) },
  { id: "quote", label: "Quote", keywords: "blockquote", icon: <QuoteIcon />, run: () => block(() => $createQuoteNode()) },
  { id: "code", label: "Code block", keywords: "code snippet pre", icon: <CodeBlockIcon />, run: () => block(() => $createCodeNode()) },
  { id: "bullets", label: "Bulleted list", keywords: "list unordered ul", icon: <BulletListIcon />, run: (editor) => void editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined) },
  { id: "numbers", label: "Numbered list", keywords: "list ordered ol", icon: <NumberedListIcon />, run: (editor) => void editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined) },
  { id: "tasks", label: "Task list", keywords: "todo checklist check", icon: <TaskListIcon />, run: (editor) => void editor.dispatchCommand(INSERT_CHECK_LIST_COMMAND, undefined) },
  {
    id: "divider",
    label: "Divider",
    keywords: "rule line hr separator",
    icon: <DividerIcon />,
    run: () => $insertNodeToNearestRoot($createDividerNode()),
  },
];

type Slash = { query: string; x: number; y: number };

/** The caret's position and the `/word` before it, when the caret sits right after a `/` that starts a word. */
function readSlash(): Slash | null {
  const sel = $getSelection();
  if (!$isRangeSelection(sel) || !sel.isCollapsed() || !$isTextNode(sel.anchor.getNode())) return null;
  const match = /(?:^|\s)\/(\w*)$/.exec(sel.anchor.getNode().getTextContent().slice(0, sel.anchor.offset));
  const rect = window.getSelection()?.getRangeAt(0).getBoundingClientRect();
  if (!match || !rect) return null;
  return { query: match[1], x: rect.left, y: rect.bottom };
}

/** Replace the `/word` the caret is after with nothing, then run the item. */
function applySlash(editor: LexicalEditor, item: SlashItem, query: string) {
  editor.update(() => {
    const sel = $getSelection();
    if ($isRangeSelection(sel)) {
      const node = sel.anchor.getNode();
      const start = sel.anchor.offset - query.length - 1;
      if ($isTextNode(node) && start >= 0 && node.getTextContent()[start] === "/") node.spliceText(start, query.length + 1, "", true);
    }
    item.run(editor);
  });
  editor.focus();
}

/** Opens after a `/` at the start of a word. Arrow keys move, Enter or Tab picks, Escape closes it. */
function SlashMenu({ onExit }: { onExit: () => void }) {
  const [editor] = useLexicalComposerContext();
  const [slash, setSlash] = useState<Slash | null>(null);
  const [index, setIndex] = useState(0);
  const q = slash?.query.toLowerCase() ?? "";
  const items = slash ? SLASH_ITEMS.filter((it) => it.label.toLowerCase().includes(q) || it.keywords.includes(q)) : [];
  // The key handlers below are registered once; they read the menu as it is now through this.
  const live = useRef({ slash, items, index, onExit });
  live.current = { slash, items, index, onExit };

  useEffect(() => {
    setIndex(0);
  }, [q]);

  useEffect(() => {
    const pick = (i: number) => {
      const { slash: s, items: list } = live.current;
      if (s && list[i]) applySlash(editor, list[i], s.query);
    };
    const step = (e: KeyboardEvent | null, by: number) => {
      const { items: list } = live.current;
      if (!list.length) return false;
      e?.preventDefault();
      setIndex((i) => (i + by + list.length) % list.length);
      return true;
    };
    return mergeRegister(
      editor.registerUpdateListener(({ editorState }) => setSlash(editorState.read(readSlash))),
      editor.registerCommand(KEY_ARROW_DOWN_COMMAND, (e) => step(e, 1), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_ARROW_UP_COMMAND, (e) => step(e, -1), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (e) => {
          if (!live.current.items.length) return false;
          e?.preventDefault();
          pick(live.current.index);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_TAB_COMMAND,
        (e) => {
          if (!live.current.items.length) return false;
          e.preventDefault();
          pick(live.current.index);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
      editor.registerCommand(
        KEY_ESCAPE_COMMAND,
        () => {
          if (live.current.slash) return setSlash(null), true;
          live.current.onExit();
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),
    );
  }, [editor]);

  if (!slash || !items.length) return null;
  return createPortal(
    <div
      data-rich-text-overlay
      role="listbox"
      aria-label="Styles"
      style={{ left: slash.x, top: slash.y + 6 }}
      className="fixed z-60 w-60 rounded-lg border border-line bg-panel p-1 shadow-lg"
    >
      {items.map((it, i) => (
        <button
          key={it.id}
          type="button"
          role="option"
          aria-selected={i === index}
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => setIndex(i)}
          onClick={() => applySlash(editor, it, slash.query)}
          className={clsx("flex w-full items-center gap-3 rounded-md px-2.5 py-1.5 text-left text-sm text-fg", i === index && "bg-fg/[0.07]")}
        >
          <span className="flex w-6 justify-center text-muted">{it.icon}</span>
          <span>{it.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
