"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { deleteTermAction, upsertTermAction } from "@/app/actions";
import { Select, useDialogs } from "@/components/ui";

type Term = { id: string; term: string; definition: string; nodeId: string | null };

export function Glossary(props: { projectKey: string; terms: Term[]; nodes: { id: string; name: string }[] }) {
  const router = useRouter();
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<string | null>(null); // term id, or "new"
  const [draft, setDraft] = useState({ term: "", definition: "", nodeId: "" });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const { confirm, dialogs } = useDialogs();
  const nodeName = new Map(props.nodes.map((n) => [n.id, n.name]));

  useEffect(() => {
    const on = () => router.refresh();
    window.addEventListener("wheelhouse:changed", on);
    return () => window.removeEventListener("wheelhouse:changed", on);
  }, [router]);

  const shown = props.terms.filter(
    (t) => !filter || t.term.toLowerCase().includes(filter.toLowerCase()) || t.definition.toLowerCase().includes(filter.toLowerCase()),
  );

  const save = (original?: Term) =>
    start(async () => {
      // Renaming = delete old + create new (terms are keyed by name).
      if (original && original.term.toLowerCase() !== draft.term.trim().toLowerCase()) {
        await deleteTermAction(props.projectKey, original.id);
      }
      const res = await upsertTermAction(props.projectKey, { term: draft.term, definition: draft.definition, node: draft.nodeId || null });
      if (!res.ok) return setError(res.error);
      setEditing(null);
      setError(null);
      router.refresh();
    });

  const form = (original?: Term) => (
    <div className="space-y-2 rounded-md border border-accent/40 bg-panel p-3">
      <div className="grid grid-cols-[1fr_200px] gap-2">
        <input className="input font-medium" placeholder="Term" value={draft.term} onChange={(e) => setDraft({ ...draft, term: e.target.value })} autoFocus />
        <Select
          value={draft.nodeId}
          options={[{ value: "", label: "No concept node" }, ...props.nodes.map((n) => ({ value: n.id, label: n.name }))]}
          onValueChange={(v) => setDraft({ ...draft, nodeId: v })}
        />
      </div>
      <textarea className="input" rows={2} placeholder="Definition: one or two plain sentences" value={draft.definition} onChange={(e) => setDraft({ ...draft, definition: e.target.value })} />
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <button className="btn btn-primary" disabled={pending || !draft.term.trim() || !draft.definition.trim()} onClick={() => save(original)}>Save</button>
        <button className="btn" onClick={() => (setEditing(null), setError(null))}>Cancel</button>
      </div>
    </div>
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Glossary</h2>
            <p className="mt-1 text-sm text-muted">
              Project vocabulary a newcomer wouldn&apos;t know. Terms are underlined with a hover definition wherever they appear in map explainers
              and decisions.
            </p>
          </div>
          <button className="btn btn-primary shrink-0" onClick={() => (setDraft({ term: "", definition: "", nodeId: "" }), setEditing("new"))}>
            + Add term
          </button>
        </div>
        <input className="input mt-5" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="mt-4 space-y-2">
          {editing === "new" && form()}
          {shown.length === 0 && editing !== "new" && <p className="py-6 text-center text-sm text-muted">No terms{filter ? " match" : " yet"}.</p>}
          {shown.map((t) =>
            editing === t.id ? (
              <div key={t.id}>{form(t)}</div>
            ) : (
              <div key={t.id} className="group card flex items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{t.term}</span>
                    {t.nodeId && nodeName.has(t.nodeId) && (
                      <Link href={`/p/${props.projectKey}/map?node=${t.nodeId}`} className="chip bg-accent/10 text-accent hover:bg-accent/20">
                        ✦ {nodeName.get(t.nodeId)}
                      </Link>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-muted">{t.definition}</p>
                </div>
                <div className="flex gap-2 text-xs opacity-0 group-hover:opacity-100">
                  <button className="text-muted hover:text-fg" onClick={() => (setDraft({ term: t.term, definition: t.definition, nodeId: t.nodeId ?? "" }), setEditing(t.id))}>
                    Edit
                  </button>
                  <button
                    className="text-muted hover:text-danger"
                    onClick={async () => {
                      if (!(await confirm({ title: `Remove “${t.term}”?`, confirmLabel: "Remove", danger: true }))) return;
                      start(async () => {
                        await deleteTermAction(props.projectKey, t.id);
                        router.refresh();
                      });
                    }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ),
          )}
        </div>
      </div>
      {dialogs}
    </div>
  );
}
