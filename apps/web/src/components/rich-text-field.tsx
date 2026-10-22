import { lazy, Suspense, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import clsx from "clsx";
import { Markdown } from "./markdown";

// Lexical is a large bundle: the field shows its text without it, and loads it on the first click.
const RichTextFieldEditor = lazy(() => import("./rich-text-field-editor").then((m) => ({ default: m.RichTextFieldEditor })));

/**
 * A piece of rich text edited in place: it reads as plain text, with no box or background, and a click on it starts editing.
 * Stored as Markdown. `onCommit` gets the new Markdown when editing ends, and only if the text changed.
 */
export function RichTextField({
  value,
  onCommit,
  label,
  placeholder,
  readOnly = false,
  className,
}: {
  value: string;
  onCommit: (markdown: string) => void;
  /** The field's name, for screen readers. */
  label: string;
  /** Shown, muted, while the field is empty. */
  placeholder?: string;
  readOnly?: boolean;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  // The latest text while editing; null until the person changes something.
  const edited = useRef<string | null>(null);
  // Read through a ref so the end of an edit always reaches the latest handler, even one that was passed in after editing began.
  const commit = useRef(onCommit);
  commit.current = onCommit;

  const start = () => {
    if (!readOnly && !editing) setEditing(true);
  };
  const finish = () => {
    setEditing(false);
    const next = edited.current;
    edited.current = null;
    if (next !== null && next !== value) commit.current(next);
  };

  const text = value.trim() ? (
    <Markdown className="md">{value}</Markdown>
  ) : readOnly ? null : (
    <span className="text-muted">{placeholder}</span>
  );

  if (editing) {
    return (
      <Suspense fallback={<div className={className}>{text}</div>}>
        <RichTextFieldEditor value={value} label={label} placeholder={placeholder} className={className} onEdit={(md) => (edited.current = md)} onExit={finish} />
      </Suspense>
    );
  }

  if (!text) return null;
  // A link inside the text opens as a link; anywhere else on it starts editing.
  const open = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest("a")) return;
    start();
  };
  const key = (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    start();
  };
  if (readOnly) return <div className={className}>{text}</div>;
  return (
    <div
      role="button"
      aria-label={`Edit ${label}`}
      tabIndex={0}
      onClick={open}
      onKeyDown={key}
      className={clsx("cursor-text rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-accent/50", className)}
    >
      {text}
    </div>
  );
}
