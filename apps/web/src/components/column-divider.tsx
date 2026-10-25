import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

export interface ColumnConfig {
  key: string; // localStorage key
  min: number;
  max: number;
  initial: number;
  step: number;
}

/** A left column's width, dragged or keyed through its `ColumnDivider`. Kept in localStorage so it survives a reload. */
export function useColumnWidth({ key, min, max, initial, step }: ColumnConfig) {
  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n)));
  const [width, setWidth] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null && raw.trim() !== "" && Number.isFinite(Number(raw))) return clamp(Number(raw));
    } catch {
      /* no storage (private mode, blocked): the default width */
    }
    return initial;
  });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const resize = (next: number) => {
    const w = clamp(next);
    setWidth(w);
    try {
      localStorage.setItem(key, String(w));
    } catch {
      /* no storage: the width still holds for this visit */
    }
  };
  const end = () => {
    drag.current = null;
    setDragging(false);
  };
  return {
    width,
    dividerProps: {
      "aria-valuenow": width,
      "aria-valuemin": min,
      "aria-valuemax": max,
      "data-dragging": dragging || undefined,
      onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, width };
        setDragging(true);
      },
      onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
        if (drag.current) resize(drag.current.width + e.clientX - drag.current.x);
      },
      onPointerUp: end,
      onPointerCancel: end,
      onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        resize(width + (e.key === "ArrowRight" ? step : -step));
      },
    },
  };
}

/** The draggable divider between a left column and the rest, md and up. */
export function ColumnDivider({ label, ...props }: { label: string } & ReturnType<typeof useColumnWidth>["dividerProps"]) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      {...props}
      className="relative hidden w-px shrink-0 cursor-col-resize touch-none bg-line outline-none before:absolute before:inset-y-0 before:-inset-x-1.5 before:content-[''] hover:bg-accent focus-visible:bg-accent data-dragging:bg-accent md:block"
    />
  );
}
