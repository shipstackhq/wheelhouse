import { useEffect, useRef } from "react";
import { Excalidraw, exportToSvg, serializeAsJSON } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";

const DEBOUNCE_MS = 1500;

type SvgInput = Parameters<typeof exportToSvg>[0];

/**
 * The Excalidraw canvas. This file is the only place that imports Excalidraw, and the editor page loads it with `lazy()`, so the
 * library (and its stylesheet) stay out of the main bundle. Changes are debounced, then handed to `onSave` as the scene JSON plus an
 * SVG thumbnail. A save still pending when the canvas unmounts is sent at once, so leaving never loses the last strokes.
 */
export default function ExcalidrawCanvas({
  scene,
  theme,
  onSave,
}: {
  /** The stored scene JSON. Read once: this canvas is not live-synced. */
  scene: string;
  theme: "light" | "dark";
  onSave: (body: string, thumbnail: string) => void;
}) {
  const initial = useRef(parseScene(scene));
  const saved = useRef(sceneKey(scene));
  const pending = useRef<(() => void) | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  useEffect(
    () => () => {
      clearTimeout(timer.current);
      pending.current?.();
    },
    [],
  );

  return (
    <Excalidraw
      initialData={initial.current}
      theme={theme}
      onChange={(elements, appState, files) => {
        const body = serializeAsJSON(elements, appState, files, "database");
        if (sceneKey(body) === saved.current) return;
        const send = () => {
          pending.current = null;
          saved.current = sceneKey(body);
          void thumbnailOf({ elements, appState, files }).then((thumbnail) => onSaveRef.current(body, thumbnail));
        };
        pending.current = send;
        clearTimeout(timer.current);
        timer.current = setTimeout(send, DEBOUNCE_MS);
      }}
    />
  );
}

/** Only drawn content decides whether anything changed (scrolling and selecting also fire onChange). */
function sceneKey(json: string) {
  try {
    const s = JSON.parse(json) as { elements?: unknown; files?: unknown };
    return JSON.stringify([s.elements, s.files]);
  } catch {
    return json;
  }
}

function parseScene(json: string) {
  try {
    const s = JSON.parse(json) as { elements?: unknown[]; files?: Record<string, unknown> };
    return { elements: s.elements ?? [], files: s.files ?? {}, scrollToContent: true } as never;
  } catch {
    return { elements: [] } as never;
  }
}

async function thumbnailOf(input: Pick<SvgInput, "elements" | "appState" | "files">) {
  const svg = await exportToSvg({ ...input, appState: { ...input.appState, exportBackground: true }, exportPadding: 16 });
  return svg.outerHTML;
}
