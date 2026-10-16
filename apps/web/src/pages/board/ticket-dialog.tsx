import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Dialog } from "radix-ui";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AutoGrowTextarea } from "../../components/auto-grow-textarea";
import { DescriptionEditor } from "../../components/description-editor";
import { HistoryList } from "../../components/history-list";
import { LabelsInput } from "../../components/labels-input";
import { errorText } from "../../components/query-state";
import { Select, useDialogs } from "../../components/ui";
import { describeFailure } from "../../lib/form-state";
import { parseLabels } from "../../lib/labels";
import { ticketQuery } from "../../lib/queries";
import { useServices } from "../../lib/services";
import { arrowStep, isDirty, singleLine, type Neighbours } from "../../lib/ticket-nav";
import { PRIORITY_STYLE, type Col, type Member, type NodeLite } from "./shared";
import { DiscussionThread } from "./thread";

/**
 * A ticket opens in a large dialog: description and discussion on the left, properties and history on the right (stacked on
 * narrow screens, full screen on phones). `?t=` stays the source of truth: the board mounts this when it is set and `onClose`
 * clears it, so refresh, back and shared links behave as before. Radix supplies the focus trap, Esc, scroll lock and focus restore.
 * The ticket is a query, so a change by anyone arrives through the live stream like everything else on the page.
 */
export function TicketDialog(props: {
  ticketRef: string;
  projectKey: string;
  columns: Col[];
  nodes: NodeLite[];
  members: Member[];
  /** Position among the tickets of the same column, as the board shows them. */
  nav: Neighbours;
  onNavigate: (ref: string) => void;
  onClose: () => void;
}) {
  const { ticketRef, columns, nodes, members, nav, onNavigate, onClose } = props;
  const { api, queryClient } = useServices();
  const query = useQuery(ticketQuery(api, ticketRef));
  const data = query.data ?? null;
  const [error, setError] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState(false);
  const [body, setBody] = useState("");
  // The ticket version the description edit started from: saving sends it, so a change made by someone else meanwhile is refused instead of overwritten.
  const [bodyBase, setBodyBase] = useState(0);
  const [title, setTitle] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [labelsPending, setLabelsPending] = useState(false);
  const { confirm, dialogs } = useDialogs();
  const content = useRef<HTMLDivElement>(null);

  const t = data?.ticket;
  // The title follows the saved one, except while the person is typing in it.
  const savedTitle = t?.title;
  useEffect(() => {
    if (savedTitle === undefined) return;
    setTitle((cur) => (document.activeElement?.id === "ticket-title" ? cur : savedTitle));
  }, [savedTitle, t?.version]);

  const dirty = isDirty({ editingBody, body, savedBody: t?.body ?? "", comment, title, savedTitle: t?.title ?? title, labelsPending });
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  /** True when it is fine to leave: nothing unsaved, or the person agreed to discard it. */
  const canLeave = useCallback(async () => {
    if (!dirtyRef.current) return true;
    return confirm({
      title: "Discard unsaved changes?",
      description: "You have a description edit, comment or title change that has not been saved.",
      confirmLabel: "Discard",
      danger: true,
    });
  }, [confirm]);

  const requestClose = useCallback(async () => {
    if (await canLeave()) onClose();
  }, [canLeave, onClose]);

  const go = useCallback(
    async (ref: string | null) => {
      if (ref && (await canLeave())) onNavigate(ref);
    },
    [canLeave, onNavigate],
  );

  // Left and right arrows step through the column, unless a field, menu or the discard prompt has the keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const step = arrowStep({
        key: e.key,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        defaultPrevented: e.defaultPrevented,
        isComposing: e.isComposing,
        target: e.target as HTMLElement | null,
      });
      if (!step) return;
      const target = step < 0 ? nav.prev : nav.next;
      if (!target) return;
      e.preventDefault();
      void go(target);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav.prev, nav.next, go]);

  /** Read the ticket and the board again: after a change, and after a refusal (which shows what is true now). */
  const reload = async () => {
    await Promise.all([query.refetch(), queryClient.invalidateQueries({ queryKey: ["board", props.projectKey] })]);
  };

  /**
   * Runs a change, then reloads. A refusal (such as a version conflict) is shown after the reload, so what is on screen is
   * the ticket as it is now, with the reason next to it. Resolves to whether the change was made.
   */
  const mutate = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
      return true;
    } catch (e) {
      const message = describeFailure(e);
      await reload();
      setError(message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  // Always saves against the latest version, and waits out a save that is still running so two quick label edits can't conflict with each other.
  const versionRef = useRef(0);
  versionRef.current = t?.version ?? versionRef.current;
  const busyRef = useRef(false);
  busyRef.current = busy;
  const saveLabels = async (labels: string[]) => {
    for (let i = 0; i < 20 && busyRef.current; i++) await new Promise((r) => setTimeout(r, 150));
    return t ? mutate(() => api.tickets.update(t.ref, { labels, version: versionRef.current })) : false;
  };

  const nodeLabel = (n: NodeLite) => {
    const parent = n.parentId ? nodes.find((p) => p.id === n.parentId) : null;
    return `${n.layer}: ${parent ? `${parent.name} › ` : ""}${n.name}`;
  };
  const linkedIds = new Set((data?.nodes ?? []).map((n) => n.id));
  const sendComment = () => {
    if (!t || !comment.trim()) return;
    const text = comment;
    setComment("");
    void mutate(() => api.tickets.comment(t.ref, text));
  };

  const loadError = query.isError && !data ? errorText(query.error) : null;

  return (
    <Dialog.Root open onOpenChange={(open) => !open && void requestClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-30 bg-black/50" />
        <Dialog.Content
          ref={content}
          tabIndex={-1}
          // Land on the dialog, not the first field: no surprise keyboard on phones, no accidental title edit.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            content.current?.focus();
          }}
          className="fixed inset-0 z-40 flex flex-col bg-panel text-fg outline-none sm:inset-auto sm:left-1/2 sm:top-1/2 sm:h-[min(92vh,60rem)] sm:w-[min(96vw,64rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:border sm:border-line sm:shadow-2xl"
        >
          <Dialog.Title className="sr-only">{t ? `${t.ref}: ${t.title}` : `Ticket ${ticketRef}`}</Dialog.Title>
          <Dialog.Description className="sr-only">Ticket description, discussion, properties and history.</Dialog.Description>

          <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5 sm:px-5">
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted">
              <span className="font-mono">{t?.ref ?? ticketRef}</span>
              {t && <span>v{t.version}</span>}
              {t?.createdByKind === "agent" && <span className="chip bg-agent/15 text-agent">🤖 created by agent</span>}
            </div>
            <div className="flex items-center gap-1">
              {nav.total > 1 && nav.index >= 0 && (
                <div className="flex items-center gap-1 text-xs text-muted">
                  <button className="btn btn-ghost px-2 py-1" disabled={!nav.prev} onClick={() => go(nav.prev)} aria-label="Previous ticket in this column" title="Previous (←)">
                    ‹
                  </button>
                  <span className="tabular-nums" aria-live="polite">
                    {nav.index + 1} / {nav.total}
                  </span>
                  <button className="btn btn-ghost px-2 py-1" disabled={!nav.next} onClick={() => go(nav.next)} aria-label="Next ticket in this column" title="Next (→)">
                    ›
                  </button>
                </div>
              )}
              <button className="btn btn-ghost px-2 py-1" onClick={() => void requestClose()} aria-label="Close ticket">
                ✕
              </button>
            </div>
          </header>

          {!t ? (
            <p className="p-5 text-sm text-muted">{loadError ?? "Loading…"}</p>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto md:grid md:grid-cols-[minmax(0,1fr)_20rem] md:overflow-hidden">
              <div className="space-y-5 px-4 py-4 sm:px-5 md:min-h-0 md:overflow-y-auto">
                {error && <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

                {/* The whole title always shows: it wraps onto as many lines as it needs. Enter saves; line breaks are not allowed. */}
                <AutoGrowTextarea
                  id="ticket-title"
                  aria-label="Title"
                  className="bg-transparent text-xl font-semibold leading-snug outline-none"
                  value={title}
                  onChange={(e) => setTitle(singleLine(e.target.value))}
                  onBlur={() => title.trim() && title !== t.title && void mutate(() => api.tickets.update(t.ref, { title, version: t.version }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      (e.target as HTMLTextAreaElement).blur();
                    }
                  }}
                />

                <section>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="label mb-0">Description</span>
                    {!editingBody && (
                      <button
                        className="text-xs text-muted hover:text-fg"
                        onClick={() => {
                          setBody(t.body);
                          setBodyBase(t.version);
                          setEditingBody(true);
                        }}
                      >
                        Edit
                      </button>
                    )}
                  </div>
                  {editingBody ? (
                    <div className="space-y-2">
                      {t.version !== bodyBase && (
                        <p role="status" className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
                          This ticket changed while you were editing (now v{t.version}). Saving will be refused so nothing is overwritten: copy your text, cancel, and apply it to the latest version.
                        </p>
                      )}
                      <DescriptionEditor value={body} onChange={setBody} />
                      <div className="flex gap-2">
                        <button
                          className="btn btn-primary"
                          disabled={busy}
                          onClick={async () => {
                            // Success leaves edit mode; a conflict keeps the draft and shows the server's message.
                            if (await mutate(() => api.tickets.update(t.ref, { body, version: bodyBase }))) setEditingBody(false);
                          }}
                        >
                          Save
                        </button>
                        <button className="btn" onClick={() => setEditingBody(false)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : t.body ? (
                    <div className="md md-quiet rounded-md bg-bg/50 p-3">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{t.body}</ReactMarkdown>
                    </div>
                  ) : (
                    <button
                      className="w-full rounded-md border border-dashed border-line p-3 text-left text-sm text-muted"
                      onClick={() => {
                        setBody("");
                        setBodyBase(t.version);
                        setEditingBody(true);
                      }}
                    >
                      Add a description…
                    </button>
                  )}
                </section>

                <section>
                  <span className="label">
                    Discussion{data && data.comments.length > 0 && <span className="normal-case text-muted/70"> ({data.comments.length})</span>}
                  </span>
                  <div className="space-y-4">
                    <DiscussionThread comments={data?.comments ?? []} />
                    <div className="space-y-2">
                      <textarea
                        className="input"
                        rows={3}
                        aria-label="Comment"
                        placeholder="Comment — agents see this in their queue"
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && sendComment()}
                      />
                      <button className="btn" disabled={!comment.trim() || busy} onClick={sendComment}>
                        Comment <span className="text-muted">⌘↵</span>
                      </button>
                    </div>
                  </div>
                </section>
              </div>

              <aside className="space-y-5 border-t border-line px-4 py-4 sm:px-5 md:min-h-0 md:overflow-y-auto md:border-l md:border-t-0">
                <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-1">
                  <Field label="Status">
                    <Select value={t.columnId} options={columns.map((c) => ({ value: c.id, label: c.name }))} onValueChange={(v) => void mutate(() => api.tickets.move(t.ref, { column: v }))} />
                  </Field>
                  <Field label="Priority">
                    <Select
                      triggerClassName={PRIORITY_STYLE[t.priority]}
                      value={t.priority}
                      options={["low", "medium", "high", "urgent"].map((p) => ({ value: p, label: p }))}
                      onValueChange={(v) => void mutate(() => api.tickets.update(t.ref, { priority: v as typeof t.priority, version: t.version }))}
                    />
                  </Field>
                  <Field label="Assignee">
                    <Select
                      value={t.assigneeId ?? ""}
                      options={[{ value: "", label: "Unassigned" }, ...members.map((m) => ({ value: m.id, label: m.name }))]}
                      onValueChange={(v) => void mutate(() => api.tickets.update(t.ref, { assigneeId: v || null, version: t.version }))}
                    />
                  </Field>
                  <Field label="AI">
                    <label className="flex h-[34px] items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={t.agentClaimable}
                        onChange={(e) => void mutate(() => api.tickets.update(t.ref, { agentClaimable: e.target.checked, version: t.version }))}
                      />
                      <span className={t.agentClaimable ? "text-agent" : "text-muted"}>Agents may pick up</span>
                    </label>
                  </Field>
                  <Field label="Labels" className="col-span-2 md:col-span-1">
                    <LabelsInput value={t.labels.join(", ")} onDirtyChange={setLabelsPending} onCommit={(csv) => saveLabels(parseLabels(csv))} />
                  </Field>
                </div>

                <section>
                  <span className="label">Architecture</span>
                  <div className="flex flex-wrap gap-1.5">
                    {data!.nodes.map((n) => (
                      <span key={n.id} className="chip gap-1 bg-accent/10 py-1 text-accent">
                        <Link className="hover:underline" to={`/p/${props.projectKey}/map?node=${n.id}`}>
                          ◇ {nodeLabel(nodes.find((x) => x.id === n.id) ?? { ...n, layer: "" })}
                        </Link>
                        <button className="text-accent/60 hover:text-accent" aria-label={`Unlink ${n.name}`} onClick={() => void mutate(() => api.tickets.unlink(t.ref, n.id))}>
                          ✕
                        </button>
                      </span>
                    ))}
                    {nodes.length > 0 ? (
                      <Select
                        className="!w-auto !border-dashed !bg-transparent !py-0.5 !text-xs !text-muted"
                        value=""
                        placeholder="+ link node"
                        options={nodes.filter((n) => !linkedIds.has(n.id)).map((n) => ({ value: n.id, label: nodeLabel(n) }))}
                        onValueChange={(v) => v && void mutate(() => api.tickets.link(t.ref, v))}
                      />
                    ) : (
                      <span className="text-xs text-muted">No nodes on the map yet.</span>
                    )}
                  </div>
                </section>

                <section>
                  <span className="label">History</span>
                  <HistoryList items={data!.history} />
                </section>

                <div className="pt-1">
                  <button
                    className="btn btn-danger"
                    onClick={async () => {
                      if (!(await confirm({ title: `Delete ${t.ref}?`, description: "This removes the ticket and its comments.", confirmLabel: "Delete", danger: true }))) return;
                      setBusy(true);
                      try {
                        await api.tickets.remove(t.ref);
                        onClose();
                        await queryClient.invalidateQueries({ queryKey: ["board", props.projectKey] });
                      } catch (e) {
                        setError(describeFailure(e));
                        setBusy(false);
                      }
                    }}
                  >
                    Delete ticket
                  </button>
                </div>
              </aside>
            </div>
          )}
          {dialogs}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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
