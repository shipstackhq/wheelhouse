"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  commentAction,
  deleteTicketAction,
  getTicketAction,
  linkNodeAction,
  moveTicketAction,
  updateTicketAction,
} from "@/app/actions";
import type { Col, Member, NodeLite } from "./board";
import { PRIORITY_STYLE } from "./board";
import { Select, useDialogs } from "@/components/ui";
import { DiscussionThread, HistoryList } from "./thread";

type Data = Extract<Awaited<ReturnType<typeof getTicketAction>>, { ok: true }>["data"];

export function TicketDrawer(props: {
  ticketRef: string;
  projectKey: string;
  columns: Col[];
  nodes: NodeLite[];
  members: Member[];
  onClose: () => void;
}) {
  const { ticketRef, columns, nodes, members, onClose } = props;
  const router = useRouter();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState(false);
  const [body, setBody] = useState("");
  const [title, setTitle] = useState("");
  const [comment, setComment] = useState("");
  const [pending, start] = useTransition();
  const { confirm, dialogs } = useDialogs();

  const load = useCallback(async () => {
    const res = await getTicketAction(ticketRef);
    if (!res.ok) return setError(res.error);
    setData(res.data);
    setTitle((cur) => (document.activeElement?.id === "ticket-title" ? cur : res.data.ticket.title));
    setError(null);
  }, [ticketRef]);

  useEffect(() => {
    load();
    const on = () => load();
    window.addEventListener("wheelhouse:changed", on);
    return () => window.removeEventListener("wheelhouse:changed", on);
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !editingBody && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, editingBody]);

  const mutate = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const res = await fn();
      if (!res.ok) setError(res.error ?? "Failed");
      await load();
      router.refresh();
    });

  if (!data) {
    return (
      <aside className="w-[480px] shrink-0 border-l border-line bg-panel p-5 text-sm text-muted">
        {error ?? "Loading…"}
      </aside>
    );
  }

  const t = data.ticket;
  const linkedIds = new Set(data.nodes.map((n) => n.id));
  const nodeLabel = (n: NodeLite) => {
    const parent = n.parentId ? nodes.find((p) => p.id === n.parentId) : null;
    return `${n.layer}: ${parent ? `${parent.name} › ` : ""}${n.name}`;
  };

  return (
    <aside className="flex w-[480px] shrink-0 flex-col border-l border-line bg-panel">
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <div className="flex items-center gap-2 text-xs text-muted">
          <span className="font-mono">{t.ref}</span>
          <span>v{t.version}</span>
          {t.createdByKind === "agent" && <span className="chip bg-agent/15 text-agent">🤖 created by agent</span>}
        </div>
        <button className="btn btn-ghost px-2 py-1" onClick={onClose} aria-label="Close">✕</button>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {error && <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

        <input
          id="ticket-title"
          className="w-full bg-transparent text-lg font-semibold outline-none"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== t.title && mutate(() => updateTicketAction(t.ref, { title }, t.version))}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />

        <div className="grid grid-cols-2 gap-3 text-sm">
          <Field label="Status">
            <Select
              value={t.columnId}
              options={columns.map((c) => ({ value: c.id, label: c.name }))}
              onValueChange={(v) => mutate(() => moveTicketAction(t.ref, v, -1))}
            />
          </Field>
          <Field label="Priority">
            <Select
              triggerClassName={PRIORITY_STYLE[t.priority]}
              value={t.priority}
              options={["low", "medium", "high", "urgent"].map((p) => ({ value: p, label: p }))}
              onValueChange={(v) => mutate(() => updateTicketAction(t.ref, { priority: v as typeof t.priority }, t.version))}
            />
          </Field>
          <Field label="Assignee">
            <Select
              value={t.assigneeId ?? ""}
              options={[{ value: "", label: "Unassigned" }, ...members.map((m) => ({ value: m.id, label: m.name }))]}
              onValueChange={(v) => mutate(() => updateTicketAction(t.ref, { assigneeId: v || null }, t.version))}
            />
          </Field>
          <Field label="AI">
            <label className="flex h-[34px] items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={t.agentClaimable}
                onChange={(e) => mutate(() => updateTicketAction(t.ref, { agentClaimable: e.target.checked }, t.version))}
              />
              <span className={t.agentClaimable ? "text-agent" : "text-muted"}>Agents may pick up</span>
            </label>
          </Field>
          <Field label="Labels" className="col-span-2">
            <input
              className="input py-1.5"
              defaultValue={t.labels.join(", ")}
              key={t.labels.join(",")}
              placeholder="bug, frontend"
              onBlur={(e) => {
                const labels = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
                if (labels.join(",") !== t.labels.join(",")) mutate(() => updateTicketAction(t.ref, { labels }, t.version));
              }}
            />
          </Field>
        </div>

        {t.ideaId && (
          <div className="text-sm text-muted">
            Promoted from an <Link href={`/ideas/${t.ideaId}`} className="underline hover:text-fg">idea</Link>
          </div>
        )}

        <section>
          <div className="mb-1 flex items-center justify-between">
            <span className="label mb-0">Description</span>
            {!editingBody && (
              <button className="text-xs text-muted hover:text-fg" onClick={() => (setBody(t.body), setEditingBody(true))}>Edit</button>
            )}
          </div>
          {editingBody ? (
            <div className="space-y-2">
              <textarea autoFocus className="input font-mono text-[13px]" rows={10} value={body} onChange={(e) => setBody(e.target.value)} />
              <div className="flex gap-2">
                <button
                  className="btn btn-primary"
                  disabled={pending}
                  onClick={() => {
                    setEditingBody(false);
                    mutate(() => updateTicketAction(t.ref, { body }, t.version));
                  }}
                >
                  Save
                </button>
                <button className="btn" onClick={() => setEditingBody(false)}>Cancel</button>
              </div>
            </div>
          ) : t.body ? (
            <div className="md rounded-md bg-bg/50 p-3"><ReactMarkdown remarkPlugins={[remarkGfm]}>{t.body}</ReactMarkdown></div>
          ) : (
            <button className="w-full rounded-md border border-dashed border-line p-3 text-left text-sm text-muted" onClick={() => (setBody(""), setEditingBody(true))}>
              Add a description…
            </button>
          )}
        </section>

        <section>
          <span className="label">Architecture</span>
          <div className="flex flex-wrap gap-1.5">
            {data.nodes.map((n) => (
              <span key={n.id} className="chip gap-1 bg-accent/10 py-1 text-accent">
                <a className="hover:underline" href={`/p/${props.projectKey}/map?node=${n.id}`}>
                ◇ {nodeLabel(nodes.find((x) => x.id === n.id) ?? (n as NodeLite))}</a>
                <button className="text-accent/60 hover:text-accent" onClick={() => mutate(() => linkNodeAction(t.ref, n.id, true))}>✕</button>
              </span>
            ))}
            {nodes.length > 0 ? (
              <Select
                className="!w-auto !border-dashed !bg-transparent !py-0.5 !text-xs !text-muted"
                value=""
                placeholder="+ link node"
                options={nodes.filter((n) => !linkedIds.has(n.id)).map((n) => ({ value: n.id, label: nodeLabel(n) }))}
                onValueChange={(v) => v && mutate(() => linkNodeAction(t.ref, v))}
              />
            ) : (
              <span className="text-xs text-muted">No nodes on the map yet.</span>
            )}
          </div>
        </section>

        <section>
          <span className="label">Discussion{data.comments.length > 0 && <span className="normal-case text-muted/70"> ({data.comments.length})</span>}</span>
          <div className="space-y-4">
            <DiscussionThread comments={data.comments} />
            <div className="space-y-2">
              <textarea
                className="input"
                rows={3}
                placeholder="Comment — agents see this in their queue"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && comment.trim()) {
                    const b = comment;
                    setComment("");
                    mutate(() => commentAction(t.ref, b));
                  }
                }}
              />
              <button
                className="btn"
                disabled={!comment.trim() || pending}
                onClick={() => {
                  const b = comment;
                  setComment("");
                  mutate(() => commentAction(t.ref, b));
                }}
              >
                Comment <span className="text-muted">⌘↵</span>
              </button>
            </div>
          </div>
        </section>

        <section>
          <span className="label">History</span>
          <HistoryList items={data.history} />
        </section>

        <div className="pt-2">
          <button
            className="btn btn-danger"
            onClick={async () => {
              if (!(await confirm({ title: `Delete ${t.ref}?`, description: "This removes the ticket and its comments.", confirmLabel: "Delete", danger: true }))) return;
              start(async () => {
                await deleteTicketAction(t.ref);
                onClose();
                router.refresh();
              });
            }}
          >
            Delete ticket
          </button>
        </div>
      </div>
      {dialogs}
    </aside>
  );
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <span className="label">{label}</span>
      {children}
    </div>
  );
}
