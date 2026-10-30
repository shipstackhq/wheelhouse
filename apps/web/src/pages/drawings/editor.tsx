import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { ApiError, type Drawing } from "@wheelhouse/api-client";
import { Link } from "../../lib/workspace";
import { Loaded } from "../../components/query-state";
import { useResolvedTheme } from "../../components/theme-toggle";
import { useDrawing } from "../../lib/queries";
import { refreshAll } from "../../lib/refresh";
import { useServices } from "../../lib/services";

// The only import path to Excalidraw: it loads when a drawing is opened, never with the main bundle.
const Canvas = lazy(() => import("./excalidraw-canvas"));

export const CONFLICT_MESSAGE = "Someone changed this drawing. Reload to see their version; your latest changes were not saved.";

/** `/t/:key/drawings/:drawingId`: the full-screen editor. Autosaves with the doc version; a conflict stops saving and asks for a reload. */
export function DrawingEditorPage() {
  const { key = "", drawingId = "" } = useParams();
  const query = useDrawing(key, drawingId);
  return (
    <Loaded query={query} label="Loading drawing">
      {(drawing) => <Editor teamKey={key} drawing={drawing} />}
    </Loaded>
  );
}

function Editor({ teamKey, drawing }: { teamKey: string; drawing: Drawing }) {
  const { api, queryClient } = useServices();
  const theme = useResolvedTheme();
  const [title, setTitle] = useState(drawing.title);
  const [status, setStatus] = useState<"saved" | "saving" | "error" | "conflict">("saved");
  const [error, setError] = useState<string | null>(null);
  // Saves go one after another so each carries the version the previous one produced.
  const version = useRef(drawing.version);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const conflict = useRef(false);

  const save = (patch: { title?: string; body?: string; thumbnail?: string }) => {
    if (conflict.current) return;
    setStatus("saving");
    queue.current = queue.current.then(async () => {
      if (conflict.current) return;
      try {
        const next = await api.drawings.update(teamKey, drawing.id, { ...patch, version: version.current });
        version.current = next.version;
        setError(null);
        setStatus("saved");
      } catch (e) {
        if (e instanceof ApiError && e.isConflict) {
          conflict.current = true;
          setStatus("conflict");
        } else {
          setStatus("error");
          setError(e instanceof ApiError ? e.message : "Cannot reach Wheelhouse. Your changes are not saved yet.");
        }
      }
    });
  };

  // Leaving: the canvas flushes its last change first (child cleanups run before this one), then the grid is refreshed.
  useEffect(
    () => () => {
      void queue.current.then(() => refreshAll(queryClient));
    },
    [queryClient],
  );

  const commitTitle = () => {
    const t = title.trim();
    if (!t) return setTitle(drawing.title);
    if (t !== drawing.title) save({ title: t });
  };

  return (
    <div className="flex h-full flex-col bg-page">
      <header className="flex items-center gap-3 border-b border-line px-3 py-2">
        <Link to={`/t/${teamKey}/drawings`} className="btn btn-ghost px-2 py-1 text-sm">
          ← Drawings
        </Link>
        <input
          className="input min-w-0 flex-1 !py-1 text-sm font-medium"
          aria-label="Drawing title"
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
        <span className="shrink-0 text-xs text-muted" role="status">
          {status === "saving" ? "Saving…" : status === "saved" ? "Saved" : ""}
        </span>
      </header>
      {status === "conflict" && (
        <p className="flex items-center gap-3 bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
          {CONFLICT_MESSAGE}
          <button className="btn btn-primary px-2 py-1 text-xs" onClick={() => window.location.reload()}>
            Reload
          </button>
        </p>
      )}
      {error && status === "error" && (
        <p className="px-3 py-2 text-sm text-danger" role="alert">
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1">
        <Suspense fallback={<p className="p-6 text-sm text-muted">Loading editor…</p>}>
          <Canvas scene={drawing.body} theme={theme} onSave={(body, thumbnail) => save({ body, thumbnail })} />
        </Suspense>
      </div>
    </div>
  );
}
