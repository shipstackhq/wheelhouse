
import { useState, useTransition } from "react";
import { Link, useNavigate } from "../../lib/workspace";
import type { Term } from "@wheelhouse/api-client";
import { Select, useDialogs } from "../../components/ui";
import { describeFailure } from "../../lib/form-state";
import { refreshAll } from "../../lib/refresh";
import { useServices } from "../../lib/services";
import { ArrowLeftIcon, EditIcon, TermIcon } from "../../components/icons";
import { Page } from "../../components/page";
import { SearchField } from "../../components/search-field";

/**
 * `/t/:key/glossary` is the team's vocabulary as a grid of cards (the layout of the docs home), each showing the term and the
 * concept it names; `/t/:key/glossary/:id` is one term, with its definition.
 */
export function Glossary(props: { teamKey: string; termId?: string; terms: Term[]; nodes: { id: string; name: string }[] }) {
  const { api, queryClient } = useServices();
  const navigate = useNavigate();
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<string | null>(null); // term id, or "new"
  const [draft, setDraft] = useState({ term: "", definition: "", nodeId: "" });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const { confirm, dialogs } = useDialogs();
  const nodeName = new Map(props.nodes.map((n) => [n.id, n.name]));
  const base = `/t/${props.teamKey}/glossary`;
  const selected = props.termId === undefined ? undefined : props.terms.find((t) => t.id === props.termId);

  const shown = props.terms.filter(
    (t) => !filter || t.term.toLowerCase().includes(filter.toLowerCase()) || t.definition.toLowerCase().includes(filter.toLowerCase()),
  );

  const save = (original?: Term) =>
    start(async () => {
      try {
        // Renaming = delete old + create new (terms are keyed by name).
        if (original && original.term.toLowerCase() !== draft.term.trim().toLowerCase()) {
          await api.map.deleteTerm(props.teamKey, original.id);
        }
        await api.map.upsertTerm(props.teamKey, draft.term.trim(), { definition: draft.definition, node: draft.nodeId || null });
        if (original && original.term.toLowerCase() !== draft.term.trim().toLowerCase()) void navigate(base);
      } catch (e) {
        setError(describeFailure(e));
        void refreshAll(queryClient);
        return;
      }
      setEditing(null);
      setError(null);
      await refreshAll(queryClient);
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

  const edit = (t: Term) => (setDraft({ term: t.term, definition: t.definition, nodeId: t.nodeId ?? "" }), setEditing(t.id));
  const remove = async (t: Term) => {
    if (!(await confirm({ title: `Remove “${t.term}”?`, confirmLabel: "Remove", danger: true }))) return;
    start(async () => {
      try {
        await api.map.deleteTerm(props.teamKey, t.id);
        if (props.termId === t.id) void navigate(base);
      } catch (e) {
        setError(describeFailure(e));
      }
      await refreshAll(queryClient);
    });
  };
  const concept = (t: Term, link: boolean) => {
    const name = t.nodeId ? nodeName.get(t.nodeId) : undefined;
    if (!t.nodeId || !name) return null;
    return link ? (
      <Link to={`/t/${props.teamKey}/map?node=${t.nodeId}`} className="chip bg-accent/10 text-accent hover:bg-accent/20">
        <TermIcon /> {name}
      </Link>
    ) : (
      <span className="chip bg-accent/10 text-accent">
        <TermIcon /> {name}
      </span>
    );
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-page">
      {props.termId === undefined ? (
        <Page
              title="Glossary"
              hint="Team vocabulary a newcomer wouldn't know. Terms are underlined with a hover definition wherever they appear in map explainers and decisions."
              action={<button className="btn btn-primary shrink-0" onClick={() => (setDraft({ term: "", definition: "", nodeId: "" }), setEditing("new"))}>+ Add term</button>}>
            {props.terms.length > 0 && (
              <SearchField value={filter} onChange={setFilter} placeholder="Filter…" label="Filter terms" />
            )}
            {editing === "new" && <div className="mb-4">{form()}</div>}
            {shown.length === 0 && editing !== "new" && <p className="py-6 text-center text-sm text-muted">No terms{filter ? " match" : " yet"}.</p>}
            {shown.length > 0 && <ul className="card divide-y divide-line overflow-hidden">
              {shown.map((t) => (
                <li key={t.id}>
                  <Link to={`${base}/${t.id}`} title={t.term} className="flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-panel-2/70 hover:underline">
                    <span className="min-w-0 flex-1 truncate font-medium">{t.term}</span>
                    {concept(t, false)}
                  </Link>
                </li>
              ))}
            </ul>}
</Page>
      ) : (
        <>
          <nav aria-label="Glossary navigation" className="flex items-center gap-2 border-b border-line/70 px-4 py-2 text-sm sm:px-8 lg:px-12">
            <Link to={base} className="shrink-0 text-muted hover:text-fg">
              <ArrowLeftIcon /> Glossary
            </Link>
          </nav>
          <section className="min-h-0 flex-1 overflow-y-auto">
            {!selected ? (
              <p className="px-4 py-8 text-sm text-muted sm:px-8 lg:px-12">This term is not in the glossary.</p>
            ) : editing === selected.id ? (
              <div className="w-full px-4 py-8 sm:px-8 lg:py-10">{form(selected)}</div>
            ) : (
              <article className="w-full space-y-5 px-4 py-8 sm:px-8 lg:py-10">
                <div className="flex items-start justify-between gap-3">
                  <h1 className="min-w-0 flex-1 text-3xl font-bold tracking-tight">{selected.term}</h1>
                  <div className="flex shrink-0 gap-2">
                    <button className="btn btn-primary" onClick={() => edit(selected)}>
                      <EditIcon /> Edit
                    </button>
                    <button className="btn btn-danger" disabled={pending} onClick={() => void remove(selected)}>
                      Remove
                    </button>
                  </div>
                </div>
                {concept(selected, true) && <div className="flex flex-wrap gap-1.5 border-b border-line/70 pb-4">{concept(selected, true)}</div>}
                <p className="text-base leading-relaxed">{selected.definition}</p>
                {error && <p className="text-sm text-danger">{error}</p>}
              </article>
            )}
          </section>
        </>
      )}
      {dialogs}
    </div>
  );
}
