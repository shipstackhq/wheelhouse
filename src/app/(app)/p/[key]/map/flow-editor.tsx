"use client";

import { useState } from "react";
import { Dialog } from "radix-ui";
import { Select } from "@/components/ui";
import { LAYER_ORDER } from "@/lib/map-shared";
import type { Graph } from "./knowledge-map";

type Step = { nodeId: string; title: string; detail: string };
export type FlowDraft = { id?: string; name: string; description: string; steps: Step[] };

export function FlowEditor(props: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  graph: Graph;
  initial: FlowDraft;
  onSave: (f: FlowDraft) => void;
  onDelete?: () => void;
}) {
  const [f, setF] = useState<FlowDraft>(props.initial);
  const options = LAYER_ORDER.flatMap((l) =>
    props.graph.nodes
      .filter((n) => n.layer === l)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((n) => ({ value: n.id, label: `${l}: ${n.name}` })),
  );
  const setStep = (i: number, patch: Partial<Step>) => setF({ ...f, steps: f.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const move = (i: number, d: number) => {
    const steps = [...f.steps];
    const j = i + d;
    if (j < 0 || j >= steps.length) return;
    [steps[i], steps[j]] = [steps[j], steps[i]];
    setF({ ...f, steps });
  };
  const valid = f.name.trim() && f.steps.every((s) => s.nodeId && s.title.trim());

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[min(94vw,640px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-line bg-panel text-fg shadow-2xl">
          <div className="border-b border-line px-5 py-3">
            <Dialog.Title className="font-semibold">{f.id ? "Edit flow" : "New flow"}</Dialog.Title>
            <Dialog.Description className="text-xs text-muted">
              A named walk through the map that explains how something works end to end. Each step happens at a node.
            </Dialog.Description>
          </div>
          <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
            <input className="input font-medium" placeholder='e.g. "User signs up"' value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            <textarea className="input" rows={2} placeholder="What this flow shows" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
            <div className="label mt-2">Steps</div>
            {f.steps.map((s, i) => (
              <div key={i} className="space-y-2 rounded-md border border-line bg-bg/40 p-3">
                <div className="flex items-center gap-2">
                  <span className="w-6 shrink-0 text-center font-mono text-xs text-muted">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <Select value={s.nodeId} placeholder="Where it happens…" options={options} onValueChange={(v) => setStep(i, { nodeId: v })} />
                  </div>
                  <button className="btn btn-ghost px-1.5 py-1 text-xs" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
                  <button className="btn btn-ghost px-1.5 py-1 text-xs" onClick={() => move(i, 1)} disabled={i === f.steps.length - 1} aria-label="Move down">↓</button>
                  <button className="btn btn-ghost px-1.5 py-1 text-xs hover:text-danger" onClick={() => setF({ ...f, steps: f.steps.filter((_, j) => j !== i) })} aria-label="Remove">✕</button>
                </div>
                <input className="input" placeholder="What happens (short)" value={s.title} onChange={(e) => setStep(i, { title: e.target.value })} />
                <textarea className="input" rows={2} placeholder="Detail (optional)" value={s.detail} onChange={(e) => setStep(i, { detail: e.target.value })} />
              </div>
            ))}
            <button className="btn w-full" onClick={() => setF({ ...f, steps: [...f.steps, { nodeId: "", title: "", detail: "" }] })}>+ Add step</button>
          </div>
          <div className="flex items-center gap-2 border-t border-line p-3">
            {props.onDelete && <button className="btn btn-danger" onClick={props.onDelete}>Delete flow</button>}
            <div className="ml-auto flex gap-2">
              <Dialog.Close className="btn">Cancel</Dialog.Close>
              <button className="btn btn-primary" disabled={!valid} onClick={() => props.onSave(f)}>Save flow</button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
