"use client";

import { useState } from "react";

/** Ordinal ramp steps (backlog → done), validated in globals.css. */
const STEPS = ["var(--stage-1)", "var(--stage-2)", "var(--stage-3)", "var(--stage-4)", "var(--stage-5)"];
export function stageColor(i: number, n: number) {
  if (n <= 1) return STEPS[4];
  return STEPS[Math.round((i * (STEPS.length - 1)) / (n - 1))];
}

export type Stage = { name: string; count: number };

/** Horizontal stacked bar of tickets per kanban column, with hover tooltip. */
export function StageBar({ stages, height = 10 }: { stages: Stage[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const total = stages.reduce((a, s) => a + s.count, 0);
  if (!total) return <div className="rounded bg-panel-2" style={{ height }} aria-label="No tickets" />;
  const shown = stages.map((s, i) => ({ ...s, i })).filter((s) => s.count > 0);
  return (
    <div className="relative" onMouseLeave={() => setHover(null)}>
      <div
        className="flex w-full gap-[2px]"
        style={{ height }}
        role="img"
        aria-label={stages.map((s) => `${s.name}: ${s.count}`).join(", ")}
      >
        {shown.map((s, k) => (
          <div
            key={s.name}
            onMouseEnter={() => setHover(s.i)}
            className="h-full transition-opacity"
            style={{
              width: `${(s.count / total) * 100}%`,
              minWidth: 4,
              background: stageColor(s.i, stages.length),
              borderTopLeftRadius: k === 0 ? 4 : 0,
              borderBottomLeftRadius: k === 0 ? 4 : 0,
              borderTopRightRadius: k === shown.length - 1 ? 4 : 0,
              borderBottomRightRadius: k === shown.length - 1 ? 4 : 0,
              opacity: hover === null || hover === s.i ? 1 : 0.45,
            }}
          />
        ))}
      </div>
      {hover !== null && (
        <div className="pointer-events-none absolute -top-9 left-0 z-10 whitespace-nowrap rounded-md border border-line bg-panel px-2 py-1 text-xs shadow-lg">
          <span className="mr-1.5 inline-block h-2 w-2 rounded-sm align-middle" style={{ background: stageColor(hover, stages.length) }} />
          {stages[hover].name}: <b>{stages[hover].count}</b> <span className="text-muted">({Math.round((stages[hover].count / total) * 100)}%)</span>
        </div>
      )}
    </div>
  );
}

export function StageLegend({ names }: { names: string[] }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
      {names.map((n, i) => (
        <span key={n} className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: stageColor(i, names.length) }} />
          {n}
        </span>
      ))}
    </div>
  );
}
