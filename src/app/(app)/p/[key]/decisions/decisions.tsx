"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Dialog } from "radix-ui";
import clsx from "clsx";
import { upsertDecisionAction } from "@/app/actions";
import { GlossaryProvider, Markdown, type GlossaryTerm } from "@/components/markdown";
import { Select } from "@/components/ui";
import { timeAgo } from "@wheelhouse/core/lib/time";

type Decision = {
  id: string;
  number: number;
  title: string;
  status: "proposed" | "accepted" | "superseded" | "rejected";
  context: string;
  decision: string;
  consequences: string;
  nodeIds: string[];
  authorKind: "human" | "agent";
  authorName: string;
  updatedAt: string;
};
type NodeLite = { id: string; name: string; layer: string };
type Draft = { number?: number; title: string; status: Decision["status"]; context: string; decision: string; consequences: string; nodeIds: string[] };

const STATUS: Record<Decision["status"], string> = {
  proposed: "bg-accent/15 text-accent",
  accepted: "bg-ok/15 text-ok",
  superseded: "bg-panel-2 text-muted",
  rejected: "bg-danger/15 text-danger",
};

export function Decisions(props: { projectKey: string; decisions: Decision[]; nodes: NodeLite[]; terms: GlossaryTerm[] }) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [hash, setHash] = useState("");
  const [query, setQuery] = useState("");
  const byId = new Map(props.nodes.map((n) => [n.id, n]));
  const q = query.trim().toLowerCase();
  const shown = [...props.decisions].reverse().filter((d) => !q || d.title.toLowerCase().includes(q));

  useEffect(() => {
    const read = () => setHash(window.location.hash.slice(1));
    read();
    window.addEventListener("hashchange", read);
    const onChange = () => router.refresh();
    window.addEventListener("wheelhouse:changed", onChange);
    return () => {
      window.removeEventListener("hashchange", read);
      window.removeEventListener("wheelhouse:changed", onChange);
    };
  }, [router]);

  useEffect(() => {
    if (hash) document.getElementById(hash)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [hash]);

  const save = (d: Draft) =>
    start(async () => {
      const res = await upsertDecisionAction(props.projectKey, {
        number: d.number,
        title: d.title,
        status: d.status,
        context: d.context,
        decision: d.decision,
        consequences: d.consequences,
        nodes: d.nodeIds,
      });
      if (!res.ok) return setError(res.error);
      setDraft(null);
      setError(null);
      router.refresh();
    });

  return (
    <GlossaryProvider terms={props.terms}>
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">Decisions</h2>
              <p className="mt-1 text-sm text-muted">
                The <i>why</i> behind non-obvious choices (ADRs), attached to the parts of the map they shape, so nobody
                &ldquo;fixes&rdquo; something that was deliberate.
              </p>
            </div>
            <button
              className="btn btn-primary shrink-0"
              onClick={() => setDraft({ title: "", status: "accepted", context: "", decision: "", consequences: "", nodeIds: [] })}
            >
              + Record decision
            </button>
          </div>

          {props.decisions.length === 0 && (
            <p className="mt-8 rounded-md border border-dashed border-line p-6 text-center text-sm text-muted">
              No decisions yet. Agents record them with <span className="font-mono">upsert_decision</span> when they make a choice a teammate might
              question.
            </p>
          )}

          {props.decisions.length > 0 && (
            <input
              type="search"
              className="input mt-6"
              placeholder="Search decisions by title"
              aria-label="Search decisions by title"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            />
          )}

          {props.decisions.length > 0 && shown.length === 0 && (
            <p className="mt-6 rounded-md border border-dashed border-line p-6 text-center text-sm text-muted">
              No decisions match &ldquo;{query.trim()}&rdquo;.
            </p>
          )}

          <div className="mt-4 space-y-4">
            {shown.map((d) => (
              <article
                key={d.id}
                id={`adr-${d.number}`}
                className={clsx("card scroll-mt-4 p-5", hash === `adr-${d.number}` && "border-accent")}
              >
                <header className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-muted">ADR-{d.number}</span>
                  <h3 className={clsx("font-semibold", (d.status === "superseded" || d.status === "rejected") && "text-muted line-through")}>{d.title}</h3>
                  <span className={clsx("chip", STATUS[d.status])}>{d.status}</span>
                  <button
                    className="ml-auto text-xs text-muted hover:text-fg"
                    onClick={() => setDraft({ number: d.number, title: d.title, status: d.status, context: d.context, decision: d.decision, consequences: d.consequences, nodeIds: d.nodeIds })}
                  >
                    Edit
                  </button>
                </header>
                {(["context", "decision", "consequences"] as const).map((k) =>
                  d[k] ? (
                    <section key={k} className="mt-3">
                      <span className="label normal-case tracking-normal">{k}</span>
                      <div className={clsx(k !== "decision" && "text-muted")}>
                        <Markdown>{d[k]}</Markdown>
                      </div>
                    </section>
                  ) : null,
                )}
                <footer className="mt-4 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                  {d.nodeIds.map((id) => {
                    const n = byId.get(id);
                    return n ? (
                      <Link key={id} href={`/p/${props.projectKey}/map?node=${id}`} className="chip bg-accent/10 py-1 text-accent hover:bg-accent/20">
                        ◇ {n.name} <span className="ml-1 opacity-60">{n.layer}</span>
                      </Link>
                    ) : null;
                  })}
                  <span className="ml-auto">
                    {d.authorKind === "agent" ? "🤖 " : ""}
                    {d.authorName} · {timeAgo(d.updatedAt)}
                  </span>
                </footer>
              </article>
            ))}
          </div>
        </div>
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
                          <button onClick={() => setDraft({ ...draft, nodeIds: draft.nodeIds.filter((x) => x !== id) })}>✕</button>
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
