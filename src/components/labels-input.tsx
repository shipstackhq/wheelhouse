"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { applyKey, applyText, formatLabels, parseLabels, settle } from "@/lib/labels";

const SAVE_DELAY_MS = 600;

/**
 * Labels as pills with an input to add more. It takes and gives the same comma-separated string as before
 * ("bug, frontend"), so nothing underneath changes. Edits show at once and are saved together after a short pause
 * (or as soon as focus leaves), so adding several labels is one save, not several racing ones.
 */
export function LabelsInput({
  value,
  onCommit,
  onDirtyChange,
  id,
  className,
}: {
  /** The saved labels, comma-separated. */
  value: string;
  /** Called with the new comma-separated string when an edit should be saved. Resolve to false if the save was refused, so the pills go back to what is saved. */
  onCommit: (csv: string) => void | boolean | Promise<void | boolean>;
  /** True while there are edits that have not been handed to `onCommit` yet (or typed text not yet a label). */
  onDirtyChange?: (dirty: boolean) => void;
  id?: string;
  className?: string;
}) {
  const saved = formatLabels(parseLabels(value));
  const [state, setState] = useState({ labels: parseLabels(value), text: "" });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The person changed something that has not been saved yet. State for what is shown, a ref for what the timers read.
  const [edited, setEditedState] = useState(false);
  const editedRef = useRef(false);
  const setEdited = (v: boolean) => {
    editedRef.current = v;
    setEditedState(v);
  };
  const input = useRef<HTMLInputElement>(null);

  const pending = edited || state.text.trim() !== "";
  useEffect(() => onDirtyChange?.(pending), [pending, onDirtyChange]);

  // Follow the saved value (live updates from others) unless there is an unsaved edit of our own.
  useEffect(() => {
    if (!editedRef.current) setState((s) => ({ labels: parseLabels(saved), text: s.text }));
  }, [saved]);

  const commit = useCallback(
    async (labels: string[]) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      setEdited(false);
      const csv = formatLabels(labels);
      if (csv === saved) return;
      // A refused save (for example a version conflict) must not leave pills on screen that were never saved.
      if ((await onCommit(csv)) === false) setState((s) => ({ labels: parseLabels(saved), text: s.text }));
    },
    [onCommit, saved],
  );

  const schedule = (labels: string[]) => {
    setEdited(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void commit(labels), SAVE_DELAY_MS);
  };
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const change = (next: { labels: string[]; text: string }) => {
    setState(next);
    if (formatLabels(next.labels) !== formatLabels(state.labels)) schedule(next.labels);
  };

  return (
    <div
      className={clsx("flex min-h-[34px] flex-wrap items-center gap-1.5", className)}
      onClick={() => input.current?.focus()}
      // focus left the whole field: turn typed text into a label and save now
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        const labels = settle(state);
        setState({ labels, text: "" });
        if (editedRef.current || labels.length !== state.labels.length) void commit(labels);
      }}
    >
      {state.labels.map((l) => (
        <span key={l.toLowerCase()} className="inline-flex items-center gap-1 rounded-full bg-panel-2 py-0.5 pl-2.5 pr-1 text-xs text-fg">
          {l}
          <button
            type="button"
            aria-label={`Remove label ${l}`}
            className="flex h-4 w-4 items-center justify-center rounded-full text-muted hover:bg-line hover:text-fg"
            onClick={(e) => {
              e.stopPropagation();
              change({ labels: state.labels.filter((x) => x !== l), text: state.text });
            }}
          >
            ×
          </button>
        </span>
      ))}
      <input
        ref={input}
        id={id}
        aria-label="Add a label"
        className="min-w-24 flex-1 bg-transparent py-0.5 text-xs outline-none placeholder:text-muted/60"
        placeholder={state.labels.length ? "Add label…" : "bug, frontend…"}
        value={state.text}
        onChange={(e) => change(applyText(state, e.target.value))}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          const r = applyKey(state, e.key);
          if (!r.prevent) return;
          e.preventDefault();
          change({ labels: r.labels, text: r.text });
        }}
      />
    </div>
  );
}
