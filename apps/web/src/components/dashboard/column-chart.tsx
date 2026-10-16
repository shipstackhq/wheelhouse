import { useState } from "react";
import clsx from "clsx";

export type Series = { key: string; label: string; color: string };
type Row = { day: string } & Record<string, number | string>;

const W = 640;
const H = 180;
const PAD = { top: 8, right: 8, bottom: 22, left: 30 };

function niceMax(v: number) {
  if (v <= 4) return Math.max(1, Math.ceil(v));
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  return (n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}
const fmtDay = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * Daily column chart: grouped (side-by-side) or stacked. Thin columns with a 4px
 * rounded data-end, 2px surface gaps, hairline grid, legend, hover tooltip and a
 * table view.
 */
export function ColumnChart({ data, series, stacked = false, label }: { data: Row[]; series: Series[]; stacked?: boolean; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const val = (r: Row, k: string) => Number(r[k] ?? 0);
  const max = niceMax(Math.max(1, ...data.map((r) => (stacked ? series.reduce((a, s) => a + val(r, s.key), 0) : Math.max(...series.map((s) => val(r, s.key)))))));
  const ticks = [0, max / 2, max].filter((t, i, a) => Number.isInteger(t) && a.indexOf(t) === i);
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const band = iw / data.length;
  const colW = Math.min(stacked ? 24 : 12, (band - 6) / (stacked ? 1 : series.length));
  const y = (v: number) => PAD.top + ih - (v / max) * ih;
  const totals = series.map((s) => data.reduce((a, r) => a + val(r, s.key), 0));

  // Column with a 4px rounded top and square base.
  const col = (x: number, top: number, bottom: number, roundTop: boolean) => {
    const h = Math.max(0, bottom - top);
    if (h <= 0) return "";
    const r = roundTop ? Math.min(4, h, colW / 2) : 0;
    return `M${x},${bottom} V${top + r} Q${x},${top} ${x + r},${top} H${x + colW - r} Q${x + colW},${top} ${x + colW},${top + r} V${bottom} Z`;
  };

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        {series.map((s, i) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
            {s.label} <span className="text-fg">{totals[i]}</span>
          </span>
        ))}
        <button className="ml-auto text-xs text-muted hover:text-fg" onClick={() => setTable((t) => !t)} aria-pressed={table}>
          {table ? "Chart" : "Table"}
        </button>
      </div>

      {table ? (
        <div className="max-h-52 overflow-auto">
          <table className="w-full text-xs tabular-nums">
            <thead className="text-muted">
              <tr>
                <th className="py-1 text-left font-normal">Day</th>
                {series.map((s) => <th key={s.key} className="py-1 text-right font-normal">{s.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.day} className="even:bg-fg/5">
                  <td className="py-1">{fmtDay(r.day)}</td>
                  {series.map((s) => <td key={s.key} className="py-1 text-right">{val(r, s.key)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={label} onMouseLeave={() => setHover(null)}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? "var(--viz-axis)" : "var(--viz-grid)"} strokeWidth={1} />
                <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={10} fill="var(--muted)" className="tabular-nums">
                  {t}
                </text>
              </g>
            ))}
            {data.map((r, i) => {
              const x0 = PAD.left + i * band;
              const showLabel = i === 0 || i === data.length - 1 || i % Math.ceil(data.length / 5) === 0;
              let acc = 0;
              const active = series.filter((s) => val(r, s.key) > 0);
              return (
                <g key={r.day} opacity={hover === null || hover === i ? 1 : 0.4}>
                  {hover === i && <rect x={x0} y={PAD.top} width={band} height={ih} fill="var(--panel-2)" />}
                  {series.map((s, si) => {
                    const v = val(r, s.key);
                    if (!v) return null;
                    if (stacked) {
                      const bottom = y(acc) - (acc > 0 ? 2 : 0); // 2px surface gap between segments
                      acc += v;
                      const isTop = active[active.length - 1]?.key === s.key;
                      return <path key={s.key} d={col(x0 + (band - colW) / 2, y(acc), bottom, isTop)} fill={s.color} />;
                    }
                    const groupW = colW * series.length + 2 * (series.length - 1);
                    const x = x0 + (band - groupW) / 2 + si * (colW + 2);
                    return <path key={s.key} d={col(x, y(v), y(0), true)} fill={s.color} />;
                  })}
                  {showLabel && (
                    <text x={x0 + band / 2} y={H - 6} textAnchor="middle" fontSize={10} fill="var(--muted)">
                      {fmtDay(r.day)}
                    </text>
                  )}
                  {/* Hit target: the whole day band, larger than the marks */}
                  <rect x={x0} y={PAD.top} width={band} height={ih + PAD.bottom} fill="transparent" onMouseEnter={() => setHover(i)} />
                </g>
              );
            })}
          </svg>
          {hover !== null && (
            <div
              className={clsx("pointer-events-none absolute top-0 z-10 whitespace-nowrap rounded-md border border-line bg-panel px-2.5 py-1.5 text-xs shadow-lg")}
              style={{
                left: `${((PAD.left + (hover + 0.5) * band) / W) * 100}%`,
                transform: hover > data.length / 2 ? "translateX(calc(-100% - 12px))" : "translateX(12px)",
              }}
            >
              <div className="mb-1 font-medium">{fmtDay(data[hover].day)}</div>
              {series.map((s) => (
                <div key={s.key} className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />
                  <span className="text-muted">{s.label}</span>
                  <span className="ml-auto pl-3 tabular-nums">{val(data[hover], s.key)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
