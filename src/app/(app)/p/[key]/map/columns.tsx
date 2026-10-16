"use client";

import { useState } from "react";
import clsx from "clsx";
import type { Column } from "@wheelhouse/core/lib/map-shared";

/** Read-only column list for a table/view/enum, with clickable FK targets. */
export function ColumnsTable(props: { columns: Column[]; isEnum: boolean; onTarget: (table: string) => void; highlight?: string | null }) {
  if (!props.columns.length) return <p className="text-xs text-muted">No columns mapped yet.</p>;
  return (
    <div className="overflow-hidden rounded-md border border-line">
      <table className="w-full text-xs">
        <tbody>
          {props.columns.map((c) => (
            <tr key={c.name} className={clsx("border-t border-line first:border-t-0", props.highlight === c.name && "bg-accent/10")}>
              <td className="w-8 px-2 py-1.5 align-top text-[9px] font-semibold text-muted">
                {c.pk ? <span className="text-accent">PK</span> : c.references ? "FK" : c.unique ? "UQ" : ""}
              </td>
              <td className="py-1.5 pr-2 align-top">
                <div className={clsx("font-mono", c.pk && "font-semibold")}>{c.name}</div>
                {c.note && <div className="mt-0.5 text-muted">{c.note}</div>}
                {c.references && (
                  <button className="mt-0.5 font-mono text-accent hover:underline" onClick={() => props.onTarget(c.references!.split(".")[0])}>
                    → {c.references}
                    {c.onDelete ? <span className="text-muted"> · on delete {c.onDelete}</span> : null}
                  </button>
                )}
              </td>
              {!props.isEnum && (
                <td className="py-1.5 pr-2 text-right align-top font-mono text-muted">
                  {c.type}
                  {c.nullable ? <span title="nullable">?</span> : null}
                  {c.default && <div className="text-[10px]">= {c.default}</div>}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Inline editor for columns. Foreign keys are set as "table.column". */
export function ColumnsEditor(props: { initial: Column[]; isEnum: boolean; tables: string[]; onSave: (cols: Column[]) => void; onCancel: () => void }) {
  const [cols, setCols] = useState<Column[]>(props.initial.length ? props.initial : [{ name: "", type: "" }]);
  const set = (i: number, patch: Partial<Column>) => setCols(cols.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const move = (i: number, d: number) => {
    const next = [...cols];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    setCols(next);
  };
  const names = cols.map((c) => c.name.trim()).filter(Boolean);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  const badRef = cols.find((c) => c.references && !/^[^.\s]+\.[^.\s]+$/.test(c.references));
  const valid = !dupes.length && !badRef;

  return (
    <div className="space-y-2">
      <datalist id="fk-targets">
        {props.tables.map((t) => (
          <option key={t} value={`${t}.id`} />
        ))}
      </datalist>
      {cols.map((c, i) => (
        <div key={i} className="space-y-1.5 rounded-md border border-line bg-bg/40 p-2">
          <div className="flex gap-1.5">
            <input className="input py-1 font-mono text-xs" placeholder={props.isEnum ? "value" : "column"} value={c.name} onChange={(e) => set(i, { name: e.target.value })} />
            {!props.isEnum && (
              <input className="input w-28 shrink-0 py-1 font-mono text-xs" placeholder="type" value={c.type} onChange={(e) => set(i, { type: e.target.value })} />
            )}
            <button className="btn btn-ghost px-1 py-0.5 text-xs" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
            <button className="btn btn-ghost px-1 py-0.5 text-xs" onClick={() => move(i, 1)} disabled={i === cols.length - 1} aria-label="Move down">↓</button>
            <button className="btn btn-ghost px-1 py-0.5 text-xs hover:text-danger" onClick={() => setCols(cols.filter((_, j) => j !== i))} aria-label="Remove column">✕</button>
          </div>
          {!props.isEnum && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
              {(["pk", "nullable", "unique"] as const).map((f) => (
                <label key={f} className="flex items-center gap-1 text-muted">
                  <input type="checkbox" checked={!!c[f]} onChange={(e) => set(i, { [f]: e.target.checked || undefined })} />
                  {f === "pk" ? "PK" : f}
                </label>
              ))}
              <input
                className="input min-w-0 flex-1 py-0.5 font-mono text-xs"
                list="fk-targets"
                placeholder="FK → table.column"
                value={c.references ?? ""}
                onChange={(e) => set(i, { references: e.target.value || undefined })}
              />
            </div>
          )}
        </div>
      ))}
      <button className="btn w-full py-1 text-xs" onClick={() => setCols([...cols, { name: "", type: "" }])}>
        + {props.isEnum ? "Value" : "Column"}
      </button>
      {dupes.length > 0 && <p className="text-xs text-danger">Duplicate: {[...new Set(dupes)].join(", ")}</p>}
      {badRef && <p className="text-xs text-danger">“{badRef.references}” should look like table.column</p>}
      <div className="flex gap-2">
        <button
          className="btn btn-primary"
          disabled={!valid}
          onClick={() =>
            props.onSave(
              cols
                .filter((c) => c.name.trim())
                .map((c) => ({ ...c, name: c.name.trim(), type: (c.type ?? "").trim(), references: c.references?.trim() || undefined })),
            )
          }
        >
          Save columns
        </button>
        <button className="btn" onClick={props.onCancel}>Cancel</button>
      </div>
    </div>
  );
}
