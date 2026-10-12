"use client";

import { useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { Select } from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { KINDS, KIND_STYLE, LAYER_META, STATUS_STYLE, subtree, type LayerId } from "@/lib/map-shared";
import { timeAgo } from "@/lib/time";
import type { Graph, GNode } from "./knowledge-map";
import { ColumnsEditor, ColumnsTable } from "./columns";
import type { Column } from "@/lib/map-shared";

type Patch = Partial<{
  name: string;
  summary: string;
  purpose: string;
  responsibilities: string;
  interfaces: string;
  gotchas: string;
  details: string;
  kind: string;
  status: string;
  parent: string | null;
  anchors: string[];
  columns: Column[];
}>;

const SECTIONS = [
  { key: "purpose", label: "Purpose", hint: "Why it exists" },
  { key: "responsibilities", label: "Responsibilities", hint: "What it owns (bullets)" },
  { key: "interfaces", label: "Interfaces", hint: "Inputs, outputs, APIs, events" },
  { key: "gotchas", label: "Gotchas", hint: "Invariants and traps" },
  { key: "details", label: "Notes", hint: "Anything else" },
] as const;

export function NodePanel(props: {
  node: GNode;
  graph: Graph;
  projectKey: string;
  onClose: () => void;
  onSelect: (id: string) => void;
  onAddChild: () => void;
  onFocus: () => void;
  onPlayFlow: (flowId: string, step: number) => void;
  onAsk: () => void;
  onSave: (patch: Patch) => void;
  onLink: (from: string, to: string) => void;
  onUnlink: (edgeId: string) => void;
  onMarkFresh: () => void;
  onDelete: () => void;
  onInternalLink: (href: string) => boolean;
  onResolveDraft: (draftId: string, action: "publish" | "discard") => void;
}) {
  const { node: n, graph: g } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => ({
    name: n.name,
    summary: n.summary,
    purpose: n.purpose,
    responsibilities: n.responsibilities,
    interfaces: n.interfaces,
    gotchas: n.gotchas,
    details: n.details,
    anchors: n.anchors.join("\n"),
  }));

  const byId = new Map(g.nodes.map((x) => [x.id, x]));
  const layer = n.layer as LayerId;
  const rank = LAYER_META[layer].rank;
  const children = g.nodes.filter((c) => c.parentId === n.id);
  const invalidParents = subtree(n.id, g.nodes);
  const out = g.edges.filter((e) => e.fromNodeId === n.id);
  const inc = g.edges.filter((e) => e.toNodeId === n.id);
  const implementsE = out.filter((e) => e.kind === "implements");
  const implementedByE = inc.filter((e) => e.kind === "implements");
  const dependsOn = out.filter((e) => e.kind === "depends");
  const usedBy = inc.filter((e) => e.kind === "depends");
  const flows = g.flows.filter((f) => f.steps.some((s) => s.nodeId === n.id));
  const decisions = g.decisions.filter((d) => d.nodeIds.includes(n.id));
  const tickets = g.ticketLinks.filter((l) => l.nodeId === n.id);
  const higher = g.nodes.filter((x) => LAYER_META[x.layer as LayerId].rank < rank && !implementsE.some((e) => e.toNodeId === x.id));
  const lower = g.nodes.filter((x) => LAYER_META[x.layer as LayerId].rank > rank && !implementedByE.some((e) => e.fromNodeId === x.id));
  const hasExplainer = SECTIONS.some((s) => n[s.key]);
  const isData = layer === "data";
  const refsOut = g.edges.filter((e) => e.kind === "references" && e.fromNodeId === n.id);
  const refsIn = g.edges.filter((e) => e.kind === "references" && e.toNodeId === n.id);
  const [editingCols, setEditingCols] = useState(false);
  const selectTable = (name: string) => {
    const t = g.nodes.find((x) => x.layer === "data" && x.name.toLowerCase() === name.toLowerCase());
    if (t) props.onSelect(t.id);
  };

  const save = () => {
    const anchors = draft.anchors.split("\n").map((s) => s.trim()).filter(Boolean);
    const patch: Patch = {};
    for (const k of ["name", "summary", "purpose", "responsibilities", "interfaces", "gotchas", "details"] as const) {
      if (draft[k] !== n[k]) patch[k] = draft[k];
    }
    if (anchors.join("\n") !== n.anchors.join("\n")) patch.anchors = anchors;
    if (Object.keys(patch).length) props.onSave(patch);
    setEditing(false);
  };

  const NodeChip = ({ id, extra }: { id: string; extra?: React.ReactNode }) => {
    const x = byId.get(id);
    if (!x) return null;
    const k = KIND_STYLE[x.kind] ?? KIND_STYLE.service;
    return (
      <button className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-panel-2" onClick={() => props.onSelect(id)}>
        <span style={{ color: k.color }}>{k.icon}</span>
        <span className="truncate">{x.name}</span>
        <span className="text-[10px] uppercase text-muted">{x.layer}</span>
        {x.stale && <span className="text-[10px] text-accent">stale</span>}
        {extra}
      </button>
    );
  };

  return (
    <aside className="flex w-[440px] shrink-0 flex-col border-l border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-5 py-3 text-xs">
        <span className="chip bg-panel-2 uppercase text-muted">{LAYER_META[layer].label}</span>
        <span className="text-muted">v{n.version}{n.describedAt ? ` · described ${timeAgo(n.describedAt)}` : ""}{n.describedSha ? ` @ ${n.describedSha.slice(0, 7)}` : ""}</span>
        <div className="ml-auto flex gap-1">
          <button className="btn btn-ghost px-2 py-1 text-xs" onClick={props.onAsk} title="Ask Claude about this node">✨ Ask</button>
          <button className="btn btn-ghost px-2 py-1" onClick={props.onClose} aria-label="Close">✕</button>
        </div>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4 text-sm">
        {g.flux[n.id] && (
          <div className="rounded-md border border-agent/40 bg-agent/5 p-3">
            <div className="font-medium text-agent">✎ In flux</div>
            {g.flux[n.id].sessions.map((s) => (
              <div key={s.id} className="mt-1 text-xs text-muted">
                {s.by}
                {s.ticket ? ` on ${s.ticket}` : ""} is changing {s.files.slice(0, 3).join(", ")}
                {s.files.length > 3 ? ` +${s.files.length - 3}` : ""}. Not landed yet.
              </div>
            ))}
            {g.flux[n.id].drafts.map((d) => (
              <div key={d.id} className="mt-2 rounded border border-line bg-panel p-2 text-xs">
                <div className="mb-1 text-muted">
                  {d.authorKind === "agent" ? "🤖 " : ""}
                  {d.authorName} {d.confirm ? "confirmed the explanation is still accurate" : `drafted: ${Object.keys(d.patch).join(", ")}`}. Publishes when the code lands.
                </div>
                {Object.entries(d.patch)
                  .filter(([, v]) => typeof v === "string")
                  .slice(0, 3)
                  .map(([k, v]) => (
                    <div key={k} className="mt-1">
                      <span className="label mb-0">{k}</span>
                      <div className="line-clamp-3 whitespace-pre-wrap">{String(v)}</div>
                    </div>
                  ))}
                <div className="mt-2 flex gap-2">
                  <button className="btn py-0.5 text-xs" onClick={() => props.onResolveDraft(d.id, "publish")}>Publish now</button>
                  <button className="btn btn-ghost py-0.5 text-xs" onClick={() => props.onResolveDraft(d.id, "discard")}>Discard</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {n.stale && (
          <div className="rounded-md border border-accent/40 bg-accent/10 p-3">
            <div className="font-medium text-accent">⚠ Possibly out of date</div>
            {n.staleReason && <div className="mt-1 text-xs text-muted">{n.staleReason}</div>}
            <div className="mt-2 flex gap-2">
              <button className="btn py-1 text-xs" onClick={props.onMarkFresh}>Still accurate — mark fresh</button>
              <button className="btn py-1 text-xs" onClick={() => setEditing(true)}>Update explanation</button>
            </div>
          </div>
        )}

        {editing ? (
          <div className="space-y-3">
            <input className="input text-base font-semibold" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <input className="input" placeholder="One-line summary" value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} />
            {SECTIONS.map((s) => (
              <div key={s.key}>
                <span className="label">{s.label} <span className="normal-case text-muted/70">— {s.hint}</span></span>
                <textarea
                  className="input font-mono text-[12.5px]"
                  rows={s.key === "purpose" ? 2 : 4}
                  value={draft[s.key]}
                  onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })}
                />
              </div>
            ))}
            {layer !== "concept" && (
              <div>
                <span className="label">Code anchors <span className="normal-case text-muted/70">— one path or glob per line</span></span>
                <textarea
                  className="input font-mono text-[12.5px]"
                  rows={3}
                  placeholder={isData ? "src/db/schema.ts#users\ndrizzle/0001_users.sql" : "src/lib/service.ts\nsrc/app/mcp/**"}
                  value={draft.anchors}
                  onChange={(e) => setDraft({ ...draft, anchors: e.target.value })}
                />
              </div>
            )}
            <div className="flex gap-2">
              <button className="btn btn-primary" onClick={save}>Save</button>
              <button className="btn" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <>
            <div>
              <div className="flex items-start justify-between gap-2">
                <h2 className="text-lg font-semibold leading-tight">{n.name}</h2>
                <button className="shrink-0 text-xs text-muted hover:text-fg" onClick={() => setEditing(true)}>Edit</button>
              </div>
              {n.summary && <p className="mt-1 text-muted">{n.summary}</p>}
            </div>
            {hasExplainer ? (
              SECTIONS.filter((s) => n[s.key]).map((s) => (
                <section key={s.key}>
                  <span className="label">{s.label}</span>
                  <Markdown onLink={props.onInternalLink}>{n[s.key]}</Markdown>
                </section>
              ))
            ) : (
              <button className="w-full rounded-md border border-dashed border-line p-3 text-left text-muted" onClick={() => setEditing(true)}>
                No explanation yet. Add purpose, responsibilities, interfaces and gotchas, or ask an agent to run
                <span className="font-mono"> refresh_map</span>.
              </button>
            )}
            {n.anchors.length > 0 && (
              <section>
                <span className="label">Code anchors</span>
                <div className="flex flex-wrap gap-1">
                  {n.anchors.map((a) => <code key={a} className="chip bg-bg font-mono text-[11px] text-muted">{a}</code>)}
                </div>
              </section>
            )}
          </>
        )}

        {isData && (
          <section>
            <div className="mb-1 flex items-center justify-between">
              <span className="label mb-0">
                {n.kind === "enum" ? "Values" : "Columns"} ({n.columns.length})
              </span>
              {!editingCols && (
                <button className="text-xs text-muted hover:text-fg" onClick={() => setEditingCols(true)}>
                  Edit
                </button>
              )}
            </div>
            {editingCols ? (
              <ColumnsEditor
                initial={n.columns}
                isEnum={n.kind === "enum"}
                tables={g.nodes.filter((x) => x.layer === "data" && x.id !== n.id).map((x) => x.name)}
                onCancel={() => setEditingCols(false)}
                onSave={(columns) => {
                  setEditingCols(false);
                  props.onSave({ columns });
                }}
              />
            ) : (
              <ColumnsTable columns={n.columns} isEnum={n.kind === "enum"} onTarget={selectTable} />
            )}
            {n.indexes.length > 0 && (
              <div className="mt-3">
                <span className="label">Indexes</span>
                <ul className="space-y-0.5 font-mono text-xs text-muted">
                  {n.indexes.map((ix, i) => (
                    <li key={i}>
                      {ix.unique ? <span className="text-fg">unique </span> : null}({ix.columns.join(", ")}){ix.name ? ` · ${ix.name}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {refsIn.length > 0 && (
              <div className="mt-3">
                <span className="label">Referenced by ({refsIn.length})</span>
                {refsIn.map((e) => (
                  <NodeChip
                    key={e.id}
                    id={e.fromNodeId}
                    extra={<span className="ml-auto font-mono text-[10px] text-muted">{e.meta?.fromColumn ? `.${e.meta.fromColumn} → .${e.meta.toColumn}` : ""}</span>}
                  />
                ))}
              </div>
            )}
            {refsOut.some((e) => !e.meta?.derived) && (
              <div className="mt-3">
                <span className="label">Also references</span>
                {refsOut.filter((e) => !e.meta?.derived).map((e) => <NodeChip key={e.id} id={e.toNodeId} />)}
              </div>
            )}
          </section>
        )}

        <div className="grid grid-cols-3 gap-2">
          <div>
            <span className="label">Kind</span>
            <Select value={n.kind} options={KINDS[layer].map((k) => ({ value: k, label: k }))} onValueChange={(v) => props.onSave({ kind: v })} />
          </div>
          <div>
            <span className="label">Status</span>
            <Select
              value={n.status}
              triggerClassName={STATUS_STYLE[n.status]}
              options={["planned", "building", "live", "deprecated"].map((x) => ({ value: x, label: x }))}
              onValueChange={(v) => props.onSave({ status: v })}
            />
          </div>
          <div className={isData ? "hidden" : undefined}>
            <span className="label">Inside</span>
            <Select
              value={n.parentId ?? ""}
              options={[
                { value: "", label: "(top level)" },
                ...g.nodes.filter((p) => p.layer === layer && !invalidParents.has(p.id)).map((p) => ({ value: p.id, label: p.name })),
              ]}
              onValueChange={(v) => props.onSave({ parent: v || null })}
            />
          </div>
        </div>

        {layer !== "concept" && (
          <LinkSection
            title="Implements"
            hint={`the higher-level ${layer === "code" ? "system or concept" : "concept"} this realizes`}
            edges={implementsE}
            otherId={(e) => e.toNodeId}
            NodeChip={NodeChip}
            onUnlink={props.onUnlink}
            options={higher.map((x) => ({ value: x.id, label: `${x.layer}: ${x.name}` }))}
            onAdd={(id) => props.onLink(n.id, id)}
          />
        )}
        {layer !== "code" && (
          <LinkSection
            title="Implemented by"
            hint={layer === "concept" ? "systems and code that realize this" : "code that realizes this"}
            edges={implementedByE}
            otherId={(e) => e.fromNodeId}
            NodeChip={NodeChip}
            onUnlink={props.onUnlink}
            options={lower.map((x) => ({ value: x.id, label: `${x.layer}: ${x.name}` }))}
            onAdd={(id) => props.onLink(id, n.id)}
          />
        )}

        {(dependsOn.length > 0 || usedBy.length > 0) && (
          <section className="grid grid-cols-2 gap-3">
            <div>
              <span className="label">Depends on</span>
              {dependsOn.map((e) => <NodeChip key={e.id} id={e.toNodeId} extra={e.label && <span className="ml-auto text-[10px] text-muted">{e.label}</span>} />)}
              {!dependsOn.length && <p className="text-xs text-muted">—</p>}
            </div>
            <div>
              <span className="label">Used by</span>
              {usedBy.map((e) => <NodeChip key={e.id} id={e.fromNodeId} />)}
              {!usedBy.length && <p className="text-xs text-muted">—</p>}
            </div>
          </section>
        )}

        <section>
          <div className="mb-1 flex items-center justify-between">
            <span className="label mb-0">Contains ({children.length})</span>
            <div className="flex gap-3 text-xs">
              {children.length > 0 && <button className="text-muted hover:text-fg" onClick={props.onFocus}>Drill in ⤢</button>}
              <button className="text-accent" onClick={props.onAddChild}>+ Add</button>
            </div>
          </div>
          {children.map((c) => <NodeChip key={c.id} id={c.id} extra={c.summary && <span className="truncate text-xs text-muted">{c.summary}</span>} />)}
        </section>

        {flows.length > 0 && (
          <section>
            <span className="label">In flows</span>
            {flows.map((f) => {
              const step = f.steps.findIndex((s) => s.nodeId === n.id);
              return (
                <button key={f.id} className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-panel-2" onClick={() => props.onPlayFlow(f.id, step)}>
                  <span className="text-accent">▶</span>
                  <span>{f.name}</span>
                  <span className="ml-auto text-xs text-muted">step {step + 1}/{f.steps.length}</span>
                </button>
              );
            })}
          </section>
        )}

        {decisions.length > 0 && (
          <section>
            <span className="label">Decisions</span>
            {decisions.map((d) => (
              <Link key={d.id} href={`/p/${props.projectKey}/decisions#adr-${d.number}`} className="flex gap-2 rounded px-1.5 py-1 hover:bg-panel-2">
                <span className="font-mono text-xs text-muted">ADR-{d.number}</span>
                <span className={clsx(d.status === "superseded" || d.status === "rejected" ? "text-muted line-through" : "")}>{d.title}</span>
              </Link>
            ))}
          </section>
        )}

        <section>
          <span className="label">Tickets touching this</span>
          {tickets.length === 0 ? (
            <p className="text-xs text-muted">None linked.</p>
          ) : (
            tickets.map((t) => (
              <Link key={t.ticketId} className="block rounded px-1.5 py-1 hover:bg-panel-2" href={`/p/${props.projectKey}?t=${t.ref}`}>
                <span className="font-mono text-xs text-muted">{t.ref}</span> {t.title}
              </Link>
            ))
          )}
        </section>

        <button className="btn btn-danger" onClick={props.onDelete}>Delete node</button>
      </div>
    </aside>
  );

  function LinkSection(p: {
    title: string;
    hint: string;
    edges: Graph["edges"];
    otherId: (e: Graph["edges"][number]) => string;
    NodeChip: (x: { id: string; extra?: React.ReactNode }) => React.ReactNode;
    onUnlink: (id: string) => void;
    options: { value: string; label: string }[];
    onAdd: (id: string) => void;
  }) {
    return (
      <section>
        <span className="label">{p.title} <span className="normal-case text-muted/70">— {p.hint}</span></span>
        {p.edges.map((e) => (
          <div key={e.id} className="group flex items-center">
            <div className="min-w-0 flex-1">{p.NodeChip({ id: p.otherId(e) })}</div>
            <button className="px-1 text-xs text-muted opacity-0 hover:text-danger group-hover:opacity-100" onClick={() => p.onUnlink(e.id)} title="Unlink">✕</button>
          </div>
        ))}
        {p.options.length > 0 && (
          <Select
            className="mt-1 !border-dashed !bg-transparent !py-1 !text-xs !text-muted"
            value=""
            placeholder={`+ link ${p.title.toLowerCase()}`}
            options={p.options}
            onValueChange={(v) => v && p.onAdd(v)}
          />
        )}
      </section>
    );
  }
}
