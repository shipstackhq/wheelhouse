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
import { $getNearestNodeOfType, mergeRegister } from "@lexical/utils";
import { $editorToMarkdown, $markdownToEditor, EDITOR_NODES, MD_TRANSFORMERS } from "../lib/markdown-editor";
import { $createImageNode } from "../lib/image-node";

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
        theme: { text: { code: "rounded bg-bg px-1 py-0.5 font-mono text-[12px]" }, link: "text-accent underline" },
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
                  fullScreen ? "mx-auto h-full w-full max-w-4xl px-6 py-8 sm:px-10" : [maxHeight, minHeight],
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

  const inList = block === "bullet" || block === "number" || block === "check";
  const blockLabel = inList ? "Paragraph" : BLOCK_LABELS[block as keyof typeof BLOCK_LABELS];

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="sticky top-0 z-10 flex flex-wrap items-center gap-x-0.5 gap-y-1 border-b border-line bg-panel-2/70 px-2 py-1.5 backdrop-blur-sm"
    >
      <ToolButton label="Bold" shortcut="⌘B" active={!!marks.bold} onClick={() => format("bold")} icon={I.bold} />
      <ToolButton label="Italic" shortcut="⌘I" active={!!marks.italic} onClick={() => format("italic")} icon={I.italic} />
      <ToolButton label="Strikethrough" active={!!marks.strikethrough} onClick={() => format("strikethrough")} icon={I.strike} />
      <ToolButton label="Inline code" active={!!marks.code} onClick={() => format("code")} icon={I.code} />
      <Divider />
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger
          aria-label="Text style"
          onMouseDown={(e) => e.preventDefault()}
          className="group inline-flex h-8 w-[7.5rem] items-center justify-between gap-1 rounded-md px-2 text-[13px] text-fg transition-colors hover:bg-fg/[0.07] data-[state=open]:bg-fg/75 data-[state=open]:text-panel"
        >
          <span className="truncate">{blockLabel}</span>
          <Svg className="h-3.5 w-3.5 shrink-0 opacity-70" fill>
            {I.caret}
          </Svg>
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
      <ToolButton label="Numbered list" active={block === "number"} onClick={() => toggleList("number")} icon={I.listOrdered} />
      <ToolButton label="Bulleted list" active={block === "bullet"} onClick={() => toggleList("bullet")} icon={I.listBullet} />
      <ToolButton label="Task list" active={block === "check"} onClick={() => toggleList("check")} icon={I.listCheck} />
      <ToolButton label="Decrease indent" disabled={!inList} onClick={() => editor.dispatchCommand(OUTDENT_CONTENT_COMMAND, undefined)} icon={I.outdent} />
      <ToolButton label="Increase indent" disabled={!inList} onClick={() => editor.dispatchCommand(INDENT_CONTENT_COMMAND, undefined)} icon={I.indent} />
      <Divider />
      <UrlPopover
        label="Link"
        active={inLink}
        icon={I.link}
        fields={["url"]}
        submitLabel="Apply"
        removeLabel={inLink ? "Remove link" : undefined}
        onRemove={() => editor.dispatchCommand(TOGGLE_LINK_COMMAND, null)}
        onSubmit={({ url }) => editor.dispatchCommand(TOGGLE_LINK_COMMAND, url)}
      />
      <UrlPopover label="Image" icon={I.image} fields={["url", "alt"]} submitLabel="Insert" onSubmit={({ url, alt }) => insertImage(url, alt)} />
      <Divider />
      <ToolButton label="Clear formatting" onClick={clearFormatting} icon={I.clear} />
      <ToolButton label="Undo" shortcut="⌘Z" disabled={!canUndo} onClick={() => editor.dispatchCommand(UNDO_COMMAND, undefined)} icon={I.undo} />
      <ToolButton label="Redo" shortcut="⇧⌘Z" disabled={!canRedo} onClick={() => editor.dispatchCommand(REDO_COMMAND, undefined)} icon={I.redo} />
      <span className="ml-auto flex items-center gap-0.5">
        {onShowMarkdown && <ToolButton label="Markdown view" onClick={onShowMarkdown} icon={I.source} />}
        <ToolButton label={fullScreen ? "Exit full screen" : "Full screen"} active={fullScreen} onClick={onToggleFullScreen} icon={fullScreen ? I.minimize : I.maximize} />
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
      className={clsx(btnClass, active && "bg-fg/[0.1] text-fg")}
    >
      <Svg>{icon}</Svg>
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
        className={clsx(btnClass, (active || open) && "bg-fg/[0.1] text-fg")}
      >
        <Svg>{icon}</Svg>
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

function Svg({ children, className = "h-[18px] w-[18px]", fill = false }: { children: ReactNode; className?: string; fill?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill={fill ? "currentColor" : "none"}
      stroke={fill ? "none" : "currentColor"}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

const BLOCK_GLYPHS: Record<keyof typeof BLOCK_LABELS, ReactNode> = {
  paragraph: <span className="text-sm">¶</span>,
  h1: <span className="text-[11px] font-bold">H1</span>,
  h2: <span className="text-[11px] font-bold">H2</span>,
  h3: <span className="text-[11px] font-bold">H3</span>,
  quote: <span className="text-base leading-none">❝</span>,
  code: <span className="font-mono text-[11px]">{"{ }"}</span>,
};
const BLOCK_PREVIEW: Record<keyof typeof BLOCK_LABELS, string> = {
  paragraph: "",
  h1: "text-base font-semibold",
  h2: "text-[15px] font-semibold",
  h3: "font-semibold",
  quote: "italic",
  code: "font-mono text-[13px]",
};

const I = {
  bold: <path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z" strokeWidth={2.25} />,
  italic: <path d="M18 5h-8M14 19H6M14.5 5 9.5 19" />,
  strike: <path d="M16 6.5C15.3 5.6 14 5 12.3 5 9.9 5 8 6.2 8 8.2c0 1.4.9 2.3 2.6 2.8M4 12h16M15.6 13.5c.3.5.4 1 .4 1.5 0 2.3-2 4-4.6 4-2 0-3.6-.8-4.4-2" />,
  code: <path d="m16 17 5-5-5-5M8 7l-5 5 5 5" />,
  caret: <path d="M7 10l5 5 5-5z" />,
  listOrdered: <path d="M10 6h10M10 12h10M10 18h10M4 5h1v4M4 9h2M6 19H4c0-1 2-1.6 2-2.8 0-.7-.5-1.2-1.2-1.2-.4 0-.8.2-1 .5" />,
  listBullet: (
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <circle cx="4.5" cy="6" r="1" fill="currentColor" />
      <circle cx="4.5" cy="12" r="1" fill="currentColor" />
      <circle cx="4.5" cy="18" r="1" fill="currentColor" />
    </>
  ),
  listCheck: <path d="m3 7 2 2 3.5-3.5M3 17l2 2 3.5-3.5M12 7h8M12 12h8M12 17h8" />,
  outdent: <path d="M4 6h16M11 10h9M11 14h9M4 18h16M8 9.5 5.5 12 8 14.5" />,
  indent: <path d="M4 6h16M11 10h9M11 14h9M4 18h16M4.5 9.5 7 12l-2.5 2.5" />,
  link: <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />,
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.75" />
      <path d="m21 16-4.5-4.5L7 20" />
    </>
  ),
  clear: <path d="M5 6V5h13v1M11.5 5 8.5 19M6.5 19h4M15 14l5 5M20 14l-5 5" />,
  undo: <path d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />,
  redo: <path d="m15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />,
  source: <path d="M9.5 8 5.5 12l4 4M14.5 8l4 4-4 4" />,
  maximize: <path d="M15 4h5v5M9 20H4v-5M20 4l-6 6M4 20l6-6" />,
  minimize: <path d="M4 14h6v6M20 10h-6V4M14 10l6-6M4 20l6-6" />,
};
