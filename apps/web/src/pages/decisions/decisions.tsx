
import { useEffect, useState, useTransition } from "react";
import { useLocation } from "react-router";
import { Link, useNavigate } from "../../lib/workspace";
import { Dialog } from "radix-ui";
import clsx from "clsx";
import type { Decision } from "@wheelhouse/api-client";
import { timeAgo } from "@wheelhouse/shared/time";
import { GlossaryProvider, Markdown, type GlossaryTerm } from "../../components/markdown";
import { Select } from "../../components/ui";
import { describeFailure } from "../../lib/form-state";
import { refreshAll } from "../../lib/refresh";
import { useServices } from "../../lib/services";
import { AgentIcon, ArrowLeftIcon, CloseIcon, EditIcon, NodeIcon, SearchIcon } from "../../components/icons";

type NodeLite = { id: string; name: string; layer: string };
/** `version` is the version being edited: sent back so a change made since is refused, not overwritten. */
type Draft = { number?: number; version?: number; title: string; status: Decision["status"]; context: string; decision: string; consequences: string; nodeIds: string[] };

const STATUS: Record<Decision["status"], string> = {
  proposed: "bg-accent/15 text-accent",
  accepted: "bg-ok/15 text-ok",
  superseded: "bg-panel-2 text-muted",
  rejected: "bg-danger/15 text-danger",
};

/**
 * `/t/:key/decisions` is the team's ADRs as a grid of cards, each showing only its title (the layout of the docs home);
 * `/t/:key/decisions/:number` is one decision, with its three sections and the map nodes it applies to.
 */
export function Decisions(props: { teamKey: string; number?: number; decisions: Decision[]; nodes: NodeLite[]; terms: GlossaryTerm[] }) {
  const { api, queryClient } = useServices();
  const navigate = useNavigate();
  const { hash } = useLocation();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [query, setQuery] = useState("");
  const byId = new Map(props.nodes.map((n) => [n.id, n]));
  const q = query.trim().toLowerCase();
  const shown = [...props.decisions].reverse().filter((d) => !q || d.title.toLowerCase().includes(q));
  const base = `/t/${props.teamKey}/decisions`;
  const selected = props.number === undefined ? undefined : props.decisions.find((d) => d.number === props.number);

  // A link made when decisions were one long page (`#adr-4`, from the activity feed and the docs) opens that decision.
  useEffect(() => {
    const m = /^#adr-(\d+)$/.exec(hash);
    if (props.number === undefined && m) void navigate(`${base}/${m[1]}`, { replace: true });
  }, [hash, props.number, base, navigate]);

  const save = (d: Draft) =>
    start(async () => {
      try {
        await api.map.upsertDecision(props.teamKey, {
          number: d.number,
          version: d.version,
          title: d.title,
          status: d.status,
          context: d.context,
          decision: d.decision,
          consequences: d.consequences,
          nodes: d.nodeIds,
        });
      } catch (e) {
        setError(describeFailure(e)); // including "was changed (version 2, you had 1)": the draft is kept
        void refreshAll(queryClient);
        return;
      }
      setDraft(null);
      setError(null);
      await refreshAll(queryClient);
    });

  const edit = (d: Decision) =>
    setDraft({ number: d.number, version: d.version, title: d.title, status: d.status, context: d.context, decision: d.decision, consequences: d.consequences, nodeIds: d.nodeIds });
  const struck = (d: Decision) => (d.status === "superseded" || d.status === "rejected") && "text-muted line-through";

  return (
    <GlossaryProvider terms={props.terms}>
      <div className="flex h-full flex-col overflow-hidden bg-page">
        {props.number === undefined ? (
          <section className="min-h-0 flex-1 overflow-y-auto">
            <div className="w-full px-4 py-8 sm:px-8 lg:py-12">
              <div className="mb-2 flex items-center justify-end gap-3">
                <h1 className="sr-only">Decisions</h1>
                <button className="btn btn-primary shrink-0" onClick={() => setDraft({ title: "", status: "accepted", context: "", decision: "", consequences: "", nodeIds: [] })}>
                  + Record decision
                </button>
              </div>
              <p className="mb-6 text-sm text-muted">
                The <i>why</i> behind non-obvious choices (ADRs), attached to the parts of the map they shape, so nobody &ldquo;fixes&rdquo; something that was deliberate.
              </p>

              {props.decisions.length === 0 && (
                <p className="rounded-md border border-dashed border-line p-6 text-center text-sm text-muted">
                  No decisions yet. Agents record them with <span className="font-mono">upsert_decision</span> when they make a choice a teammate might question.
                </p>
              )}

              {props.decisions.length > 0 && (
                <div className="relative mb-4">
                  <input
                    type="search"
                    className="input !rounded-full !border-transparent !bg-panel-2/70 !py-1.5 !pr-8 text-sm focus:!border-accent"
                    placeholder="Search decisions…"
                    aria-label="Search decisions by title"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Escape" && setQuery("")}
                  />
                  <SearchIcon className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-base text-muted" />
                </div>
              )}

              {props.decisions.length > 0 && shown.length === 0 && (
                <p className="rounded-md border border-dashed border-line p-6 text-center text-sm text-muted">No decisions match &ldquo;{query.trim()}&rdquo;.</p>
              )}

              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {shown.map((d) => (
                  <li key={d.id}>
                    <Link
                      to={`${base}/${d.number}`}
                      title={d.title}
                      className="card flex h-full min-h-20 flex-col gap-3 rounded-xl px-4 py-4 transition-colors hover:border-accent hover:bg-panel-2/70"
                    >
                      <span className={clsx("line-clamp-3 text-[15px] font-medium leading-snug", struck(d))}>{d.title}</span>
                      <span className="mt-auto flex flex-wrap gap-1.5">
                        <span className={clsx("chip", STATUS[d.status])}>{d.status}</span>
                        {d.nodeIds.slice(0, 3).map((id) => {
                          const n = byId.get(id);
                          return n ? <span key={id} className="chip bg-accent/10 text-accent">{n.name}</span> : null;
                        })}
                        {d.nodeIds.length > 3 && <span className="chip bg-panel-2 text-muted">+{d.nodeIds.length - 3}</span>}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        ) : (
          <>
            <nav aria-label="Decision navigation" className="flex items-center gap-2 border-b border-line/70 px-4 py-2 text-sm sm:px-8 lg:px-12">
              <Link to={base} className="shrink-0 text-muted hover:text-fg">
                <ArrowLeftIcon /> Decisions
              </Link>
            </nav>
            <section className="min-h-0 flex-1 overflow-y-auto">
              {!selected ? (
                <p className="px-4 py-8 text-sm text-muted sm:px-8 lg:px-12">No decision ADR-{props.number} in this team.</p>
              ) : (
                <article className="w-full space-y-5 px-4 py-8 sm:px-8 lg:py-10">
                  <div className="flex items-start justify-between gap-3">
                    <h1 className={clsx("min-w-0 flex-1 text-3xl font-bold tracking-tight", struck(selected))}>{selected.title}</h1>
                    <button className="btn btn-primary shrink-0" onClick={() => edit(selected)}>
                      <EditIcon /> Edit
                    </button>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-line/70 pb-4 text-xs text-muted">
                    <span className="font-mono">ADR-{selected.number}</span>
                    <span className={clsx("chip", STATUS[selected.status])}>{selected.status}</span>
                    <span>
                      {selected.authorKind === "agent" && <AgentIcon />}{selected.authorKind === "agent" && " "}
                      {selected.authorName} · {timeAgo(selected.updatedAt)}
                    </span>
                  </div>
                  {(["context", "decision", "consequences"] as const).map((k) =>
                    selected[k] ? (
                      <section key={k}>
                        <span className="label normal-case tracking-normal">{k}</span>
                        <div className={clsx(k !== "decision" && "text-muted")}>
                          <Markdown>{selected[k]}</Markdown>
                        </div>
                      </section>
                    ) : null,
                  )}
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    {selected.nodeIds.map((id) => {
                      const n = byId.get(id);
                      return n ? (
                        <Link key={id} to={`/t/${props.teamKey}/map?node=${id}`} className="chip bg-accent/10 py-1 text-accent hover:bg-accent/20">
                          <NodeIcon /> {n.name} <span className="ml-1 opacity-60">{n.layer}</span>
                        </Link>
                      ) : null;
                    })}
                  </div>
                </article>
              )}
            </section>
          </>
        )}
      </div>

      <Dialog.Root open={!!draft} onOpenChange={(o) => !o && setDraft(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[min(94vw,640px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-line bg-panel text-fg shadow-2xl">
            {draft && (
              <>
                <div className="border-b border-line px-5 py-3">
                  <Dialog.Title className="font-semibold">{draft.number ? `Edit ADR-${draft.number}` : "Record a decision"}</Dialog.Title>
                  <Dialog.Description className="text-xs text-muted">A few sentences each. Markdown is supported.</Dialog.Description>
                </div>
                <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
                  <div className="grid grid-cols-[1fr_140px] gap-2">
                    <input className="input" placeholder='e.g. "Use 303 redirects for auth handshakes"' value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
                    <Select
                      value={draft.status}
                      options={(["proposed", "accepted", "superseded", "rejected"] as const).map((s) => ({ value: s, label: s }))}
                      onValueChange={(v) => setDraft({ ...draft, status: v as Decision["status"] })}
                    />
                  </div>
                  {(
                    [
                      ["context", "What forced a choice? Constraints, the problem."],
                      ["decision", "What we chose."],
                      ["consequences", "What follows: trade-offs, what not to change."],
                    ] as const
                  ).map(([k, hint]) => (
                    <div key={k}>
                      <span className="label normal-case tracking-normal">{k} <span className="text-muted/70">— {hint}</span></span>
                      <textarea className="input" rows={3} value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
                    </div>
                  ))}
                  <div>
                    <span className="label normal-case tracking-normal">Applies to</span>
                    <div className="flex flex-wrap gap-1.5">
                      {draft.nodeIds.map((id) => (
                        <span key={id} className="chip gap-1 bg-accent/10 py-1 text-accent">
                          {byId.get(id)?.name ?? "?"}
                          <button onClick={() => setDraft({ ...draft, nodeIds: draft.nodeIds.filter((x) => x !== id) })}><CloseIcon /></button>
                        </span>
                      ))}
                      <Select
                        className="!w-auto !border-dashed !bg-transparent !py-0.5 !text-xs !text-muted"
                        value=""
                        placeholder="+ map node"
                        options={props.nodes.filter((n) => !draft.nodeIds.includes(n.id)).map((n) => ({ value: n.id, label: `${n.layer}: ${n.name}` }))}
                        onValueChange={(v) => v && setDraft({ ...draft, nodeIds: [...draft.nodeIds, v] })}
                      />
                    </div>
                  </div>
                  {error && <p className="text-sm text-danger">{error}</p>}
                </div>
                <div className="flex justify-end gap-2 border-t border-line p-3">
                  <Dialog.Close className="btn">Cancel</Dialog.Close>
                  <button className="btn btn-primary" disabled={!draft.title.trim() || pending} onClick={() => save(draft)}>
                    Save
                  </button>
                </div>
              </>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </GlossaryProvider>
  );
}
