import { useEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { DropdownMenu, Popover } from "radix-ui";
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
import { TablePlugin } from "@lexical/react/LexicalTablePlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createHeadingNode, $createQuoteNode, $isHeadingNode, $isQuoteNode } from "@lexical/rich-text";
import { $createCodeNode, $isCodeNode } from "@lexical/code";
import { INSERT_CHECK_LIST_COMMAND, INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND, $isListNode, ListNode } from "@lexical/list";
import { $isLinkNode, TOGGLE_LINK_COMMAND } from "@lexical/link";
import { $setBlocksType } from "@lexical/selection";
import {
  $getSelection,
  $createParagraphNode,
  $insertNodes,
  $isRangeSelection,
  $isTextNode,
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_LOW,
  FORMAT_TEXT_COMMAND,
  INDENT_CONTENT_COMMAND,
  OUTDENT_CONTENT_COMMAND,
  REDO_COMMAND,
  SELECTION_CHANGE_COMMAND,
  UNDO_COMMAND,
  type ElementNode,
  type TextFormatType,
} from "lexical";
import { $createTableNodeWithDimensions } from "@lexical/table";
import { $getNearestNodeOfType, $insertNodeToNearestRoot, mergeRegister } from "@lexical/utils";
import { $editorToMarkdown, $markdownToEditor, EDITOR_NODES, MD_TRANSFORMERS } from "../lib/markdown-editor";
import { $createImageNode } from "../lib/image-node";
import { $createDividerNode } from "../lib/md-blocks";
import { BoldIcon, BulletListIcon, ChevronDownIcon, ClearFormattingIcon, CodeBlockIcon, DividerIcon, ExitFullscreenIcon, FullscreenIcon, Heading1Icon, Heading2Icon, Heading3Icon, ImageIcon, IndentIcon, InlineCodeIcon, ItalicIcon, LinkIcon, MarkdownIcon, NumberedListIcon, OutdentIcon, ParagraphIcon, QuoteIcon, RedoIcon, StrikethroughIcon, TableIcon, TaskListIcon, UndoIcon } from "./icons";

type Block = "paragraph" | "h1" | "h2" | "h3" | "quote" | "code" | "bullet" | "number" | "check";
type ListKind = "bullet" | "number" | "check";

/**
 * A rich-text editor for a Markdown string. Markdown stays the stored format: `onChange` only fires after
 * the person edits (never on load), so opening and saving an untouched description writes back exactly what was there.
 * The toolbar offers only what Markdown can store (no fonts, colours or alignment), so nothing is lost on save.
 */
export function RichMarkdownEditor({
  value,
  onChange,
  autoFocus = true,
  className,
  contentClassName = "px-3 py-2",
  minHeight = "min-h-48",
  maxHeight = "max-h-[50vh]",
  onShowMarkdown,
}: {
  value: string;
  onChange: (markdown: string) => void;
  autoFocus?: boolean;
  className?: string;
  /** Padding and type size of the editable area (docs use roomier settings than ticket descriptions). */
  contentClassName?: string;
  /** Tailwind min-height class for the editable area — widen for long-form content (e.g. docs) vs. the default ticket-description sizing. */
  minHeight?: string;
  /** Tailwind max-height class for the editable area (controls scroll). */
  maxHeight?: string;
  /** When given, the toolbar has a "Markdown view" button that calls it. */
  onShowMarkdown?: () => void;
}) {
  const [fullScreen, setFullScreen] = useState(false);

  useEffect(() => {
    if (!fullScreen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFullScreen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullScreen]);

  return (
    <LexicalComposer
      initialConfig={{
        namespace: "wheelhouse-markdown",
        nodes: EDITOR_NODES,
        editorState: () => $markdownToEditor(value),
        onError: (e) => console.error("[rich editor]", e),
        theme: {
          text: { code: "rounded bg-bg px-1 py-0.5 font-mono text-[12px]" },
          link: "text-accent underline",
          table: "my-3 w-full border-collapse text-sm",
          tableCell: "min-w-16 border border-line px-2 py-1 align-top",
          tableCellHeader: "bg-panel-2 font-semibold",
        },
      }}
    >
      <div
        className={clsx(
          "flex flex-col overflow-hidden rounded-md border border-line bg-panel",
          fullScreen ? "fixed inset-0 z-50 rounded-none border-0" : className,
        )}
      >
        <Toolbar fullScreen={fullScreen} onToggleFullScreen={() => setFullScreen((f) => !f)} onShowMarkdown={onShowMarkdown} />
        <div className={clsx("relative", fullScreen && "min-h-0 flex-1")}>
          <RichTextPlugin
            contentEditable={
              <ContentEditable
                aria-label="Description"
                className={clsx(
                  "md overflow-y-auto outline-none",
                  contentClassName,
                  fullScreen ? "h-full w-full px-6 py-8 sm:px-10" : [maxHeight, minHeight],
                )}
              />
            }
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
      <TablePlugin />
      <MarkdownShortcutPlugin transformers={MD_TRANSFORMERS} />
      {autoFocus && <AutoFocusPlugin />}
      <OnChangePlugin
        ignoreSelectionChange
        onChange={(state) => state.read(() => onChange($editorToMarkdown()))}
      />
    </LexicalComposer>
  );
}

const BLOCK_LABELS: Record<"paragraph" | "h1" | "h2" | "h3" | "quote" | "code", string> = {
  paragraph: "Paragraph",
  h1: "Heading 1",
  h2: "Heading 2",
  h3: "Heading 3",
  quote: "Quote",
  code: "Code block",
};

function Toolbar({ fullScreen, onToggleFullScreen, onShowMarkdown }: { fullScreen: boolean; onToggleFullScreen: () => void; onShowMarkdown?: () => void }) {
  const [editor] = useLexicalComposerContext();
  const [block, setBlock] = useState<Block>("paragraph");
  const [marks, setMarks] = useState<Record<string, boolean>>({});
  const [inLink, setInLink] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  useEffect(() => {
    const read = () => {
      const sel = $getSelection();
      if (!$isRangeSelection(sel)) return;
      setMarks({ bold: sel.hasFormat("bold"), italic: sel.hasFormat("italic"), strikethrough: sel.hasFormat("strikethrough"), code: sel.hasFormat("code") });
      const node = sel.anchor.getNode();
      setInLink($isLinkNode(node.getParent()) || $isLinkNode(node));
      const top = node.getTopLevelElementOrThrow();
      const list = $getNearestNodeOfType(node, ListNode);
      if ($isListNode(top) || list) {
        const t = list?.getListType();
        setBlock(t === "check" ? "check" : t === "number" ? "number" : "bullet");
      } else if ($isHeadingNode(top)) setBlock(top.getTag() as Block);
      else if ($isQuoteNode(top)) setBlock("quote");
      else if ($isCodeNode(top)) setBlock("code");
      else setBlock("paragraph");
    };
    return mergeRegister(
      editor.registerUpdateListener(({ editorState }) => editorState.read(read)),
      editor.registerCommand(SELECTION_CHANGE_COMMAND, () => (editor.getEditorState().read(read), false), COMMAND_PRIORITY_LOW),
      editor.registerCommand(CAN_UNDO_COMMAND, (v) => (setCanUndo(v), false), COMMAND_PRIORITY_LOW),
      editor.registerCommand(CAN_REDO_COMMAND, (v) => (setCanRedo(v), false), COMMAND_PRIORITY_LOW),
    );
  }, [editor]);

  const format = (f: TextFormatType) => editor.dispatchCommand(FORMAT_TEXT_COMMAND, f);
  const setType = (make: () => ElementNode) =>
    editor.update(() => {
      const sel = $getSelection();
      if ($isRangeSelection(sel)) $setBlocksType(sel, make);
    });
  const setBlockStyle = (b: keyof typeof BLOCK_LABELS) => {
    if (b === "paragraph") setType($createParagraphNode);
    else if (b === "quote") setType($createQuoteNode);
    else if (b === "code") setType(() => $createCodeNode());
    else setType(() => $createHeadingNode(b));
  };
  const listCommands = { bullet: INSERT_UNORDERED_LIST_COMMAND, number: INSERT_ORDERED_LIST_COMMAND, check: INSERT_CHECK_LIST_COMMAND } as const;
  const toggleList = (kind: ListKind) => (block === kind ? setType($createParagraphNode) : editor.dispatchCommand(listCommands[kind], undefined));
  const clearFormatting = () => {
    editor.update(() => {
      const sel = $getSelection();
      if (!$isRangeSelection(sel)) return;
      for (const n of sel.getNodes()) if ($isTextNode(n)) n.setFormat(0).setStyle("");
    });
    editor.dispatchCommand(TOGGLE_LINK_COMMAND, null);
  };
  const insertImage = (src: string, alt: string) =>
    editor.update(() => {
      $insertNodes([$createImageNode(src, alt)]);
    });

  const insertTable = () =>
    editor.update(() => {
      $insertNodeToNearestRoot($createTableNodeWithDimensions(3, 3, true));
    });
  const insertDivider = () =>
    editor.update(() => {
      $insertNodeToNearestRoot($createDividerNode());
    });

  const inList = block === "bullet" || block === "number" || block === "check";
  const blockLabel = inList ? "Paragraph" : BLOCK_LABELS[block as keyof typeof BLOCK_LABELS];

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="sticky top-0 z-10 flex flex-wrap items-center gap-x-0.5 gap-y-1 border-b border-line bg-panel-2/70 px-2 py-1.5 backdrop-blur-sm"
    >
      <ToolButton label="Bold" shortcut="⌘B" active={!!marks.bold} onClick={() => format("bold")} icon={<BoldIcon />} />
      <ToolButton label="Italic" shortcut="⌘I" active={!!marks.italic} onClick={() => format("italic")} icon={<ItalicIcon />} />
      <ToolButton label="Strikethrough" active={!!marks.strikethrough} onClick={() => format("strikethrough")} icon={<StrikethroughIcon />} />
      <ToolButton label="Inline code" active={!!marks.code} onClick={() => format("code")} icon={<InlineCodeIcon />} />
      <Divider />
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger
          aria-label="Text style"
          onMouseDown={(e) => e.preventDefault()}
          className="group inline-flex h-8 w-[7.5rem] items-center justify-between gap-1 rounded-md px-2 text-[13px] text-fg transition-colors hover:bg-fg/[0.07] data-[state=open]:bg-fg/75 data-[state=open]:text-panel"
        >
          <span className="truncate">{blockLabel}</span>
          <ChevronDownIcon className="shrink-0 opacity-70" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            sideOffset={4}
            onCloseAutoFocus={(e) => (e.preventDefault(), editor.focus())}
            className="z-[60] min-w-48 rounded-lg border border-line bg-panel p-1 shadow-lg"
          >
            {(Object.keys(BLOCK_LABELS) as (keyof typeof BLOCK_LABELS)[]).map((b) => (
              <DropdownMenu.Item
                key={b}
                onSelect={() => setBlockStyle(b)}
                className={clsx(
                  "flex cursor-default items-center gap-3 rounded-md px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-fg/[0.07]",
                  block === b ? "text-accent" : "text-fg",
                )}
              >
                <span className="flex w-6 justify-center text-muted">{BLOCK_GLYPHS[b]}</span>
                <span className={BLOCK_PREVIEW[b]}>{BLOCK_LABELS[b]}</span>
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <Divider />
      <ToolButton label="Numbered list" active={block === "number"} onClick={() => toggleList("number")} icon={<NumberedListIcon />} />
      <ToolButton label="Bulleted list" active={block === "bullet"} onClick={() => toggleList("bullet")} icon={<BulletListIcon />} />
      <ToolButton label="Task list" active={block === "check"} onClick={() => toggleList("check")} icon={<TaskListIcon />} />
      <ToolButton label="Decrease indent" disabled={!inList} onClick={() => editor.dispatchCommand(OUTDENT_CONTENT_COMMAND, undefined)} icon={<OutdentIcon />} />
      <ToolButton label="Increase indent" disabled={!inList} onClick={() => editor.dispatchCommand(INDENT_CONTENT_COMMAND, undefined)} icon={<IndentIcon />} />
      <Divider />
      <UrlPopover
        label="Link"
        active={inLink}
        icon={<LinkIcon />}
        fields={["url"]}
        submitLabel="Apply"
        removeLabel={inLink ? "Remove link" : undefined}
        onRemove={() => editor.dispatchCommand(TOGGLE_LINK_COMMAND, null)}
        onSubmit={({ url }) => editor.dispatchCommand(TOGGLE_LINK_COMMAND, url)}
      />
      <UrlPopover label="Image" icon={<ImageIcon />} fields={["url", "alt"]} submitLabel="Insert" onSubmit={({ url, alt }) => insertImage(url, alt)} />
      <ToolButton label="Table" onClick={insertTable} icon={<TableIcon />} />
      <ToolButton label="Divider" onClick={insertDivider} icon={<DividerIcon />} />
      <Divider />
      <ToolButton label="Clear formatting" onClick={clearFormatting} icon={<ClearFormattingIcon />} />
      <ToolButton label="Undo" shortcut="⌘Z" disabled={!canUndo} onClick={() => editor.dispatchCommand(UNDO_COMMAND, undefined)} icon={<UndoIcon />} />
      <ToolButton label="Redo" shortcut="⇧⌘Z" disabled={!canRedo} onClick={() => editor.dispatchCommand(REDO_COMMAND, undefined)} icon={<RedoIcon />} />
      <span className="ml-auto flex items-center gap-0.5">
        {onShowMarkdown && <ToolButton label="Markdown view" onClick={onShowMarkdown} icon={<MarkdownIcon />} />}
        <ToolButton label={fullScreen ? "Exit full screen" : "Full screen"} active={fullScreen} onClick={onToggleFullScreen} icon={fullScreen ? <ExitFullscreenIcon /> : <FullscreenIcon />} />
      </span>
    </div>
  );
}

const btnClass =
  "inline-flex h-8 min-w-8 items-center justify-center rounded-md px-1.5 text-muted transition-colors hover:bg-fg/[0.07] hover:text-fg disabled:pointer-events-none disabled:opacity-35";

function ToolButton({
  label,
  shortcut,
  icon,
  active = false,
  disabled = false,
  onClick,
}: {
  label: string;
  shortcut?: string;
  icon: ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      // keep the selection in the editor when a toolbar button is pressed
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={clsx(btnClass, "text-lg", active && "bg-fg/[0.1] text-fg")}
    >
      {icon}
    </button>
  );
}

/** A toolbar button that opens a small form (link address, or image address and description). */
function UrlPopover({
  label,
  icon,
  fields,
  submitLabel,
  active = false,
  removeLabel,
  onRemove,
  onSubmit,
}: {
  label: string;
  icon: ReactNode;
  fields: ("url" | "alt")[];
  submitLabel: string;
  active?: boolean;
  removeLabel?: string;
  onRemove?: () => void;
  onSubmit: (v: { url: string; alt: string }) => void;
}) {
  const [editor] = useLexicalComposerContext();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [alt, setAlt] = useState("");
  const urlRef = useRef<HTMLInputElement>(null);

  const close = () => {
    setOpen(false);
    setUrl("");
    setAlt("");
  };

  return (
    <Popover.Root open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <Popover.Trigger
        title={label}
        aria-label={label}
        aria-pressed={active}
        onMouseDown={(e) => e.preventDefault()}
        className={clsx(btnClass, "text-lg", (active || open) && "bg-fg/[0.1] text-fg")}
      >
        {icon}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          onOpenAutoFocus={(e) => (e.preventDefault(), urlRef.current?.focus())}
          onCloseAutoFocus={(e) => (e.preventDefault(), editor.focus())}
          className="z-[60] w-72 space-y-2 rounded-lg border border-line bg-panel p-3 shadow-lg"
        >
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              const u = url.trim();
              if (!u) return;
              onSubmit({ url: u, alt: alt.trim() });
              close();
            }}
          >
            <label className="block text-xs text-muted">
              {label === "Image" ? "Image address" : "Link address"}
              <input ref={urlRef} className="input mt-1 text-sm" type="url" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} />
            </label>
            {fields.includes("alt") && (
              <label className="block text-xs text-muted">
                Description (for screen readers)
                <input className="input mt-1 text-sm" value={alt} onChange={(e) => setAlt(e.target.value)} />
              </label>
            )}
            <div className="flex items-center justify-end gap-2 pt-1">
              {removeLabel && onRemove && (
                <button type="button" className="mr-auto text-xs text-danger hover:underline" onClick={() => (onRemove(), close())}>
                  {removeLabel}
                </button>
              )}
              <button type="button" className="btn px-2 py-1 text-xs" onClick={close}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary px-2 py-1 text-xs" disabled={!url.trim()}>
                {submitLabel}
              </button>
            </div>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

const Divider = () => <span className="mx-1 h-5 w-px bg-line" aria-hidden />;


const BLOCK_GLYPHS: Record<keyof typeof BLOCK_LABELS, ReactNode> = {
  paragraph: <ParagraphIcon />,
  h1: <Heading1Icon />,
  h2: <Heading2Icon />,
  h3: <Heading3Icon />,
  quote: <QuoteIcon />,
  code: <CodeBlockIcon />,
};
const BLOCK_PREVIEW: Record<keyof typeof BLOCK_LABELS, string> = {
  paragraph: "",
  h1: "text-base font-semibold",
  h2: "text-[15px] font-semibold",
  h3: "font-semibold",
  quote: "italic",
  code: "font-mono text-[13px]",
};
