import { lazy, Suspense, useEffect, useState } from "react";
import clsx from "clsx";

// Lexical is a large bundle: load it only when someone actually edits a description, not with the board.
const RichMarkdownEditor = lazy(() => import("./rich-markdown-editor").then((m) => ({ default: m.RichMarkdownEditor })));
const EditorLoading = () => <div className="min-h-48 animate-pulse rounded-md border border-line bg-panel-2" aria-busy />;

type Mode = "rich" | "markdown";
const KEY = "wh:editor-mode";

/**
 * Edit a Markdown string as rich text or as raw Markdown. Both edit the same string, so switching never loses anything;
 * raw Markdown is always one click away for anything the rich view doesn't show (tables, HTML). The choice is remembered per browser.
 */
export function DescriptionEditor({
  value,
  onChange,
  size = "compact",
}: {
  value: string;
  onChange: (markdown: string) => void;
  /** "compact" (default, ticket descriptions) or "full" (long-form docs: more vertical room). */
  size?: "compact" | "full";
}) {
  const [mode, setMode] = useState<Mode>("rich");
  // The editor takes `value` only as its starting point, so it is remounted (new key) when the mode changes and starts from the current text.
  const [seed, setSeed] = useState(value);

  useEffect(() => {
    try {
      if (localStorage.getItem(KEY) === "markdown") switchTo("markdown", false);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchTo = (m: Mode, remember = true) => {
    setSeed(value);
    setMode(m);
    if (!remember) return;
    try {
      localStorage.setItem(KEY, m);
    } catch {}
  };

  const tab = (m: Mode, label: string) => (
    <button
      type="button"
      aria-pressed={mode === m}
      onClick={() => mode !== m && switchTo(m)}
      className={clsx("rounded px-2 py-0.5 text-xs", mode === m ? "bg-panel-2 text-fg" : "text-muted hover:text-fg")}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-1.5">
      <div role="group" aria-label="Editor type" className="flex items-center gap-1">
        {tab("rich", "Rich text")}
        {tab("markdown", "Markdown")}
      </div>
      {mode === "rich" ? (
        <Suspense fallback={<EditorLoading />}>
          <RichMarkdownEditor
            value={seed}
            onChange={onChange}
            minHeight={size === "full" ? "min-h-[60vh]" : "min-h-48"}
            maxHeight={size === "full" ? "max-h-[70vh]" : "max-h-[50vh]"}
          />
        </Suspense>
      ) : (
        <textarea
          autoFocus
          className={clsx("input font-mono text-[13px]", size === "full" ? "min-h-[60vh]" : "min-h-48")}
          rows={size === "full" ? 32 : 14}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}
