import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Link, wsKey } from "../../lib/workspace";
import { useQuery } from "@tanstack/react-query";
import { Dialog, Popover } from "radix-ui";
import ReactMarkdown from "react-markdown";
import type { CycleOption, IssueRelative, TeamProjectOption } from "@wheelhouse/api-client";
import remarkGfm from "remark-gfm";
import { AutoGrowTextarea } from "../../components/auto-grow-textarea";
import { DescriptionEditor } from "../../components/description-editor";
import { HistoryList } from "../../components/history-list";
import { LabelsInput } from "../../components/labels-input";
import { errorText } from "../../components/query-state";
import { Select, useDialogs } from "../../components/ui";
import { describeFailure } from "../../lib/form-state";
import { parseLabels } from "../../lib/labels";
import { boardQuery, issueQuery, teamAgentsQuery } from "../../lib/queries";
import { parentCandidates } from "../../lib/sub-issues";
import { DelegatePlan, IssueTargetsSection } from "./issue-targets";
import { PriorityIcon } from "../../components/priority-icon";
import { SubIssueProgress } from "../../components/sub-issue-progress";
import { useServices } from "../../lib/services";
import { arrowStep, isDirty, singleLine, type Neighbours } from "../../lib/issue-nav";
import { PRIORITY_STYLE, type Col, type Member, type NodeLite } from "./shared";
import { DiscussionThread } from "./thread";
import { IssueRunsSection } from "./issue-runs";
import { cycleTitle } from "../cycles/cycle-bits";
import { AgentIcon, ChevronLeftIcon, ChevronRightIcon, CloseIcon, NodeIcon } from "../../components/icons";

/**
 * An issue opens in a large dialog: description and discussion on the left, properties and history on the right (stacked on
 * narrow screens, full screen on phones). `?t=` stays the source of truth: the board mounts this when it is set and `onClose`
 * clears it, so refresh, back and shared links behave as before. Radix supplies the focus trap, Esc, scroll lock and focus restore.
 * The issue is a query, so a change by anyone arrives through the live stream like everything else on the page.
 */
export function IssueDialog(props: {
  issueRef: string;
  teamKey: string;
  columns: Col[];
  nodes: NodeLite[];
  members: Member[];
  /** The team's cycles, for the Cycle field. */
  cycles?: CycleOption[];
  /** The projects the team takes part in, with their milestones, for the Project and Milestone fields. */
  projects?: TeamProjectOption[];
  /** Position among the issues of the same column, as the board shows them. */
  nav: Neighbours;
  onNavigate: (ref: string) => void;
  onClose: () => void;
}) {
  const { issueRef, columns, nodes, members, nav, onNavigate, onClose } = props;
  const cycles = props.cycles ?? [];
  const projects = props.projects ?? [];
  const { api, queryClient } = useServices();
  const query = useQuery(issueQuery(api, issueRef));
  const roster = useQuery(teamAgentsQuery(api, props.teamKey)).data ?? [];
  const data = query.data ?? null;
  const [error, setError] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState(false);
  const [body, setBody] = useState("");
  // The issue version the description edit started from: saving sends it, so a change made by someone else meanwhile is refused instead of overwritten.
  const [bodyBase, setBodyBase] = useState(0);
  const [title, setTitle] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [labelsPending, setLabelsPending] = useState(false);
  const [subIssueDraft, setSubIssueDraft] = useState(false);
  const { confirm, dialogs } = useDialogs();
  const content = useRef<HTMLDivElement>(null);

  const t = data?.issue;
  // The title follows the saved one, except while the person is typing in it.
  const savedTitle = t?.title;
  useEffect(() => {
    if (savedTitle === undefined) return;
    setTitle((cur) => (document.activeElement?.id === "issue-title" ? cur : savedTitle));
  }, [savedTitle, t?.version]);

  const dirty = isDirty({ editingBody, body, savedBody: t?.body ?? "", comment, title, savedTitle: t?.title ?? title, labelsPending, subIssueDraft });
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

  /** Read the issue and the board again: after a change, and after a refusal (which shows what is true now). */
  const reload = async () => {
    await Promise.all([query.refetch(), queryClient.invalidateQueries({ queryKey: wsKey(api, "board", props.teamKey) })]);
  };

  /**
   * Runs a change, then reloads. A refusal (such as a version conflict) is shown after the reload, so what is on screen is
   * the issue as it is now, with the reason next to it. Resolves to whether the change was made.
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
    return t ? mutate(() => api.issues.update(t.ref, { labels, version: versionRef.current })) : false;
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
    void mutate(() => api.issues.comment(t.ref, text));
  };

  const loadError = query.isError && !data ? errorText(query.error) : null;

  return (
    <Dialog.Root open onOpenChange={(open) => !open && void requestClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content
          ref={content}
          tabIndex={-1}
          // Land on the dialog, not the first field: no surprise keyboard on phones, no accidental title edit.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            content.current?.focus();
          }}
          className="fixed inset-0 z-50 flex flex-col bg-panel text-fg outline-none sm:inset-auto sm:left-1/2 sm:top-1/2 sm:h-[min(92vh,60rem)] sm:w-[min(96vw,64rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:border sm:border-line sm:shadow-2xl"
        >
          <Dialog.Title className="sr-only">{t ? `${t.ref}: ${t.title}` : `Issue ${issueRef}`}</Dialog.Title>
          <Dialog.Description className="sr-only">Issue description, discussion, properties and history.</Dialog.Description>

          <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5 sm:px-5">
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted">
              <span className="font-mono">{t?.ref ?? issueRef}</span>
              {t && <span>v{t.version}</span>}
              {t?.createdByKind === "agent" && <span className="chip bg-agent/15 text-agent"><AgentIcon /> created by agent</span>}
            </div>
            <div className="flex items-center gap-1">
              {nav.total > 1 && nav.index >= 0 && (
                <div className="flex items-center gap-1 text-xs text-muted">
                  <button className="btn btn-ghost px-2 py-1" disabled={!nav.prev} onClick={() => go(nav.prev)} aria-label="Previous issue in this column" title="Previous (←)">
                    <ChevronLeftIcon />
                  </button>
                  <span className="tabular-nums" aria-live="polite">
                    {nav.index + 1} / {nav.total}
                  </span>
                  <button className="btn btn-ghost px-2 py-1" disabled={!nav.next} onClick={() => go(nav.next)} aria-label="Next issue in this column" title="Next (→)">
                    <ChevronRightIcon />
                  </button>
                </div>
              )}
              <button className="btn btn-ghost px-2 py-1" onClick={() => void requestClose()} aria-label="Close issue">
                <CloseIcon />
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
                  id="issue-title"
                  aria-label="Title"
                  className="bg-transparent text-xl font-semibold leading-snug outline-none"
                  value={title}
                  onChange={(e) => setTitle(singleLine(e.target.value))}
                  onBlur={() => title.trim() && title !== t.title && void mutate(() => api.issues.update(t.ref, { title, version: t.version }))}
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
                          This issue changed while you were editing (now v{t.version}). Saving will be refused so nothing is overwritten: copy your text, cancel, and apply it to the latest version.
                        </p>
                      )}
                      <DescriptionEditor value={body} onChange={setBody} />
                      <div className="flex gap-2">
                        <button
                          className="btn btn-primary"
                          disabled={busy}
                          onClick={async () => {
                            // Success leaves edit mode; a conflict keeps the draft and shows the server's message.
                            if (await mutate(() => api.issues.update(t.ref, { body, version: bodyBase }))) setEditingBody(false);
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

                <SubIssues
                  issue={t}
                  subIssues={data?.children ?? []}
                  busy={busy}
                  onDraftChange={setSubIssueDraft}
                  onOpen={(ref) => void go(ref)}
                  onAdd={(title) => mutate(() => api.issues.create(props.teamKey, { title, parent: t.ref }))}
                />

                <IssueTargetsSection
                  issueRef={t.ref}
                  targets={data?.targets ?? []}
                  proposed={data?.proposedTargets ?? []}
                  inherited={data?.targetsInherited ?? false}
                  delegation={t.delegation?.state ?? null}
                  busy={busy}
                  onChange={(targets) => void mutate(() => api.issues.update(t.ref, { targets, version: t.version }))}
                />

                <IssueRunsSection issueRef={t.ref} teamKey={props.teamKey} targets={data?.targets ?? []} delegated={!!t.delegateAgentId} />

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
                    <Select value={t.statusId} options={columns.map((c) => ({ value: c.id, label: c.name }))} onValueChange={(v) => void mutate(() => api.issues.move(t.ref, { status: v }))} />
                  </Field>
                  <Field label="Priority">
                    <Select
                      triggerClassName={PRIORITY_STYLE[t.priority]}
                      value={t.priority}
                      options={["none", "low", "medium", "high", "urgent"].map((p) => ({ value: p, label: p === "none" ? "no priority" : p }))}
                      onValueChange={(v) => void mutate(() => api.issues.update(t.ref, { priority: v as typeof t.priority, version: t.version }))}
                    />
                  </Field>
                  <Field label="Assignee">
                    <Select
                      value={t.assigneeId ?? ""}
                      options={[{ value: "", label: "Unassigned" }, ...members.map((m) => ({ value: m.id, label: m.name }))]}
                      onValueChange={(v) => void mutate(() => api.issues.update(t.ref, { assigneeId: v || null, version: t.version }))}
                    />
                  </Field>
                  <Field label="Delegate">
                    <Select
                      disabled={!roster.length}
                      value={roster.find((a) => a.id === t.delegateAgentId)?.slug ?? ""}
                      options={roster.length ? [{ value: "", label: "Nobody" }, ...roster.map((a) => ({ value: a.slug, label: `${a.name} · ${a.role}` }))] : [{ value: "", label: "No agents on this team" }]}
                      onValueChange={(v) => void mutate(() => api.issues.update(t.ref, { delegate: v || null, version: t.version }))}
                    />
                    {!t.delegateAgentId && data?.suggestedAgent && roster.some((a) => a.slug === data.suggestedAgent) && (
                      <button type="button" className="mt-1 text-xs text-accent hover:underline" disabled={busy} onClick={() => void mutate(() => api.issues.update(t.ref, { delegate: data.suggestedAgent, version: t.version }))}>
                        Suggested: {roster.find((a) => a.slug === data.suggestedAgent)!.name}
                      </button>
                    )}
                    {t.delegateAgentId && <DelegatePlan issueRef={t.ref} agent={roster.find((a) => a.id === t.delegateAgentId)?.slug ?? ""} />}
                  </Field>
                  <Field label="Parent">
                    <ParentField
                      teamKey={props.teamKey}
                      issue={t}
                      parent={data?.parent ?? null}
                      onOpen={(ref) => void go(ref)}
                      onSet={(ref) => void mutate(() => api.issues.update(t.ref, { parent: ref, version: t.version }))}
                    />
                  </Field>
                  {(cycles.length > 0 || t.cycle != null) && (
                    <Field label="Cycle">
                      <Select
                        value={t.cycle == null ? "" : String(t.cycle)}
                        // A cycle that has ended is closed to new issues, but an issue already in one still shows it.
                        options={[
                          { value: "", label: "No cycle" },
                          ...cycles.filter((c) => c.state !== "past" || c.number === t.cycle).map((c) => ({ value: String(c.number), label: cycleTitle(c) })),
                        ]}
                        onValueChange={(v) => void mutate(() => api.issues.update(t.ref, { cycle: v ? Number(v) : null, version: t.version }))}
                      />
                    </Field>
                  )}
                  {(projects.length > 0 || t.projectId != null) && (
                    <Field label="Project">
                      <Select
                        value={t.projectId ?? ""}
                        options={[{ value: "", label: "No project" }, ...projects.map((x) => ({ value: x.id, label: x.name }))]}
                        onValueChange={(v) => void mutate(() => api.issues.update(t.ref, { projectId: v || null, version: t.version }))}
                      />
                    </Field>
                  )}
                  {t.projectId != null && (projects.find((x) => x.id === t.projectId)?.milestones.length ?? 0) > 0 && (
                    <Field label="Milestone">
                      <Select
                        value={t.milestoneId ?? ""}
                        options={[{ value: "", label: "No milestone" }, ...(projects.find((x) => x.id === t.projectId)?.milestones ?? []).map((m) => ({ value: m.id, label: m.name }))]}
                        onValueChange={(v) => void mutate(() => api.issues.update(t.ref, { milestoneId: v || null, version: t.version }))}
                      />
                    </Field>
                  )}
                  <Field label="AI">
                    <label className="flex h-[34px] items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={t.agentClaimable}
                        onChange={(e) => void mutate(() => api.issues.update(t.ref, { agentClaimable: e.target.checked, version: t.version }))}
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
                        <Link className="hover:underline" to={`/t/${props.teamKey}/map?node=${n.id}`}>
                          <NodeIcon /> {nodeLabel(nodes.find((x) => x.id === n.id) ?? { ...n, layer: "" })}
                        </Link>
                        <button className="text-accent/60 hover:text-accent" aria-label={`Unlink ${n.name}`} onClick={() => void mutate(() => api.issues.unlink(t.ref, n.id))}>
                          <CloseIcon />
                        </button>
                      </span>
                    ))}
                    {nodes.length > 0 ? (
                      <Select
                        className="!w-auto !border-dashed !bg-transparent !py-0.5 !text-xs !text-muted"
                        value=""
                        placeholder="+ link node"
                        options={nodes.filter((n) => !linkedIds.has(n.id)).map((n) => ({ value: n.id, label: nodeLabel(n) }))}
                        onValueChange={(v) => v && void mutate(() => api.issues.link(t.ref, v))}
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
                      if (!(await confirm({ title: `Delete ${t.ref}?`, description: data!.children.length ? `This removes the issue and its comments. Its ${data!.children.length === 1 ? "sub-issue stays, as a top-level issue" : `${data!.children.length} sub-issues stay, as top-level issues`}.` : "This removes the issue and its comments.", confirmLabel: "Delete", danger: true }))) return;
                      setBusy(true);
                      try {
                        await api.issues.remove(t.ref);
                        onClose();
                        await queryClient.invalidateQueries({ queryKey: wsKey(api, "board", props.teamKey) });
                      } catch (e) {
                        setError(describeFailure(e));
                        setBusy(false);
                      }
                    }}
                  >
                    Delete issue
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

/** The issue's sub-issues, how far along they are, each opening in place, and a box to add one. */
function SubIssues(props: {
  issue: { ref: string };
  subIssues: IssueRelative[];
  busy: boolean;
  /** Whether a title has been typed and not yet added, so closing the dialog can ask first (as it does for a comment). */
  onDraftChange: (draft: boolean) => void;
  onOpen: (ref: string) => void;
  onAdd: (title: string) => Promise<boolean>;
}) {
  const kids = props.subIssues;
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const draft = (v: string) => {
    setTitle(v);
    props.onDraftChange(v.trim() !== "");
  };
  const stop = () => {
    draft("");
    setAdding(false);
  };
  const counted = kids.filter((k) => !k.canceled);
  const progress = { done: counted.filter((k) => k.done).length, total: counted.length };
  if (kids.length === 0 && !adding) {
    return (
      <section aria-label="Sub-issues">
        <button type="button" className="text-xs text-muted hover:text-fg" onClick={() => setAdding(true)}>+ Add sub-issue</button>
      </section>
    );
  }
  return (
    <section aria-label="Sub-issues">
      <div className="mb-1 flex items-center justify-between">
        <span className="label mb-0 flex items-center gap-2">
          Sub-issues <SubIssueProgress progress={progress} />
        </span>
        {!adding && (
          <button type="button" className="text-xs text-muted hover:text-fg" onClick={() => setAdding(true)}>
            + Add sub-issue
          </button>
        )}
      </div>
      {kids.length > 0 && (
        <ul className="divide-y divide-line rounded-md border border-line">
          {kids.map((k) => (
            <li key={k.ref} className="flex items-center gap-2 px-2 py-1.5 text-sm" data-sub-issue={k.ref}>
              <PriorityIcon priority={k.priority} />
              <span className="font-mono text-[11px] text-muted">{k.ref}</span>
              <button type="button" className={clsx("min-w-0 flex-1 truncate text-left hover:underline", (k.done || k.canceled) && "text-muted line-through")} onClick={() => props.onOpen(k.ref)}>
                {k.title}
              </button>
              <span className="chip bg-bg text-muted">{k.status}</span>
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const v = title.trim();
            if (!v) return stop();
            draft("");
            await props.onAdd(v);
          }}
        >
          <input
            autoFocus
            className="input min-w-0 flex-1 py-1"
            aria-label="New sub-issue title"
            placeholder="Sub-issue title"
            value={title}
            disabled={props.busy}
            onChange={(e) => draft(e.target.value)}
          />
          <button type="submit" className="btn btn-primary py-1" disabled={props.busy}>Add</button>
          <button type="button" className="btn py-1" onClick={stop}>Cancel</button>
        </form>
      )}
    </section>
  );
}

/**
 * Whose sub-issue this is: the parent (opening it, or taking it away), or a button to choose one from the team's issues. The choice
 * never offers the issue itself or anything below it, which would be a loop; the server refuses those too.
 */
function ParentField(props: { teamKey: string; issue: { id: string; ref: string }; parent: { ref: string; title: string } | null; onOpen: (ref: string) => void; onSet: (ref: string | null) => void }) {
  const { api } = useServices();
  const board = useQuery(boardQuery(api, props.teamKey));
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const candidates = parentCandidates(board.data?.issues ?? [], props.issue.id)
    .filter((c) => words.every((w) => `${c.ref} ${c.title}`.toLowerCase().includes(w)))
    .slice(0, 30);
  return (
    <div className="flex items-center gap-1">
      {props.parent && (
        <button type="button" className="min-w-0 flex-1 truncate rounded border border-line px-2 py-1.5 text-left text-sm hover:bg-panel-2" onClick={() => props.onOpen(props.parent!.ref)} title={props.parent.title}>
          <span className="font-mono text-[11px] text-muted">{props.parent.ref}</span> {props.parent.title}
        </button>
      )}
      <Popover.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQ(""); }}>
        <Popover.Trigger className={clsx("btn py-1.5 text-xs", props.parent ? "px-2" : "w-full justify-start text-muted")} aria-label={props.parent ? "Change parent" : "Set parent"}>
          {props.parent ? "Change" : "No parent"}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="end" sideOffset={4} collisionPadding={8} className="z-[60] w-72 rounded-lg border border-line bg-panel p-2 text-sm text-fg shadow-xl">
            <input autoFocus type="search" className="input mb-1 py-1" aria-label="Find an issue" placeholder="Find an issue" value={q} onChange={(e) => setQ(e.target.value)} />
            <ul className="max-h-60 overflow-y-auto" aria-label="Issues">
              {candidates.map((c) => (
                <li key={c.id}>
                  <button type="button" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-panel-2" onClick={() => { setOpen(false); props.onSet(c.ref); }}>
                    <span className="font-mono text-[11px] text-muted">{c.ref}</span>
                    <span className="truncate">{c.title}</span>
                  </button>
                </li>
              ))}
              {candidates.length === 0 && <li className="px-2 py-2 text-xs text-muted">No issue matches.</li>}
            </ul>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {props.parent && (
        <button type="button" className="rounded p-1 text-muted hover:text-danger" aria-label="Remove parent" onClick={() => props.onSet(null)}>
          <CloseIcon aria-hidden />
        </button>
      )}
    </div>
  );
}
