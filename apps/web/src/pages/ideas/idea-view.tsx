import { useState, useTransition } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "../../lib/workspace";
import { ApiError, type IdeaDetail, type IdeaInput, type IdeaStatus } from "@wheelhouse/api-client";
import { BookIcon, CloseIcon } from "../../components/icons";
import { DescriptionEditor } from "../../components/description-editor";
import { MermaidPre } from "../../components/mermaid";
import { Select } from "../../components/ui";
import { describeFailure } from "../../lib/form-state";
import { refreshAll } from "../../lib/refresh";
import { useServices } from "../../lib/services";
import { useTeams } from "../../lib/session";
import { readTime } from "../docs/file-tree";
import { SETTABLE_STATUSES, ideaStatusChip, issueHref, when } from "./idea-bits";

const failure = (e: unknown) => (e instanceof ApiError ? e.message || "Failed" : describeFailure(e));

/**
 * One idea, laid out like a doc: a large borderless title and a rich-text body edited in place, a side panel (author, status, team tag,
 * labels, Promote) and the discussion below. Title and body save together against the version the edit started from; a stale save is
 * refused and nothing is overwritten. Status, team and labels save as soon as they change. A promoted idea stays editable.
 */
export function IdeaView(props: { idea: IdeaDetail }) {
  const { idea } = props;
  const { api, queryClient } = useServices();
  const teams = useTeams().data ?? [];
  const [title, setTitle] = useState(idea.title);
  const [body, setBody] = useState(idea.body);
  // The version the open edit started from; `editorKey` remounts the editor, which takes its text only as a starting point.
  const [base, setBase] = useState(idea.version);
  const [editorKey, setEditorKey] = useState(0);
  const [newLabel, setNewLabel] = useState("");
  const [comment, setComment] = useState("");
  const [commentKey, setCommentKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const dirty = title !== idea.title || body !== idea.body;
  // Nothing is being edited: follow the server, so the next edit starts from what is saved.
  if (!dirty && base !== idea.version) {
    setBase(idea.version);
    setTitle(idea.title);
    setBody(idea.body);
    setEditorKey((k) => k + 1);
  }
  const stale = dirty && base !== idea.version;

  const run = (fn: () => Promise<unknown>, after?: () => void) =>
    start(async () => {
      try {
        await fn();
        setError(null);
        after?.();
      } catch (e) {
        setError(failure(e));
      } finally {
        await refreshAll(queryClient);
      }
    });

  /** A change made from the side panel, against the version that was read. Mid-edit it is not someone else's edit: carry the base on. */
  const change = (patch: IdeaInput, after?: () => void) =>
    run(async () => {
      const saved = await api.ideas.update(idea.id, { ...patch, version: idea.version });
      if (base === idea.version) setBase(saved.version);
      after?.();
    });

  const save = () =>
    run(async () => {
      const patch: IdeaInput = {};
      if (title.trim() !== idea.title) patch.title = title;
      if (body !== idea.body) patch.body = body;
      const saved = await api.ideas.update(idea.id, { ...patch, version: base });
      setBase(saved.version);
      setTitle(saved.title);
      setBody(saved.body);
      setEditorKey((k) => k + 1);
    });

  const discard = () => {
    setTitle(idea.title);
    setBody(idea.body);
    setBase(idea.version);
    setEditorKey((k) => k + 1);
    setError(null);
  };

  const promote = () =>
    run(async () => {
      const saved = await api.ideas.promote(idea.id, idea.team?.key);
      if (base === idea.version) setBase(saved.version);
    });

  const promoted = idea.status === "promoted";
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-6 py-6">
        <div className="flex flex-wrap items-center gap-3">
          <Link to="/ideas" className="text-sm text-muted hover:text-fg">← Ideas</Link>
          {idea.promotedIssue && (
            <span className="rounded-md border border-ok/40 bg-ok/10 px-2 py-1 text-sm">
              Promoted to{" "}
              <Link to={issueHref(idea.promotedIssue.ref)} className="font-semibold hover:underline">
                {idea.promotedIssue.ref}
              </Link>{" "}
              · {idea.promotedIssue.title}
            </span>
          )}
        </div>

        <div className="mt-4 grid gap-8 md:grid-cols-[minmax(0,1fr)_16rem]">
          <div className="min-w-0">
            {idea.canEdit ? (
              <input className="w-full border-0 bg-transparent p-0 text-3xl font-semibold outline-none placeholder:text-muted/60" aria-label="Title" placeholder="Untitled idea" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
            ) : (
              <h2 className="text-3xl font-semibold">{idea.title}</h2>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-line/70 pb-4 text-xs text-muted">
              <span>
                By {idea.author.name}
                {idea.author.kind === "agent" && " (agent)"} · {when(idea.createdAt)}
              </span>
              <span><BookIcon /> {readTime(body)} min read</span>
              <span className="ml-auto text-muted/70">v{idea.version}</span>
            </div>

            {stale && (
              <p role="status" className="mt-4 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
                This idea changed while you were editing (now v{idea.version}). Saving will be refused so nothing is overwritten: copy your
                text, discard your edit, and apply it to the latest version.
              </p>
            )}
            <div className="mt-4">
              {idea.canEdit ? (
                <DescriptionEditor key={editorKey} value={body} onChange={setBody} size="full" />
              ) : idea.body ? (
                <div className="md md-quiet rounded-lg bg-panel/40 p-6">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: MermaidPre }} skipHtml>
                    {idea.body}
                  </ReactMarkdown>
                </div>
              ) : null}
            </div>
            {idea.canEdit && dirty && (
              <div className="mt-3 flex gap-2">
                <button className="btn btn-primary" disabled={pending || !title.trim()} onClick={save}>
                  Save
                </button>
                <button className="btn" disabled={pending} onClick={discard}>
                  Discard
                </button>
              </div>
            )}
            {error && <p className="mt-3 text-sm text-danger" role="alert">{error}</p>}

            <h3 className="mt-8 text-sm font-semibold">Comments</h3>
            <div className="mt-2 space-y-2">
              {idea.comments.length === 0 && <p className="text-sm text-muted">No comments yet.</p>}
              {idea.comments.map((c) => (
                <div key={c.id} className="card px-3 py-2">
                  <p className="text-xs text-muted">
                    {c.authorName}
                    {c.authorKind === "agent" && " (agent)"} · {when(c.createdAt)}
                  </p>
                  <div className="md md-quiet mt-1 text-sm">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: MermaidPre }} skipHtml>
                      {c.body}
                    </ReactMarkdown>
                  </div>
                </div>
              ))}
            </div>
            {idea.canEdit && (
              <form
                className="mt-3 space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (comment.trim()) run(() => api.ideas.comment(idea.id, comment.trim()), () => (setComment(""), setCommentKey((k) => k + 1)));
                }}
              >
                <DescriptionEditor key={commentKey} value={comment} onChange={setComment} />
                <button type="submit" className="btn" disabled={pending || !comment.trim()}>
                  Comment
                </button>
              </form>
            )}
          </div>

          <aside aria-label="About this idea" className="space-y-5 self-start text-sm md:sticky md:top-6">
            <section>
              <span className="label">Author</span>
              <p>
                {idea.author.name}
                {idea.author.kind === "agent" && " (agent)"}
              </p>
            </section>
            <section>
              <span className="label">Status</span>
              {idea.canEdit && !promoted ? (
                <Select ariaLabel="Status" value={idea.status} options={SETTABLE_STATUSES.map((s) => ({ value: s, label: s }))} onValueChange={(v) => change({ status: v as Exclude<IdeaStatus, "promoted"> })} />
              ) : (
                ideaStatusChip(idea.status)
              )}
            </section>
            <section>
              <span className="label">Team tag</span>
              {idea.canEdit ? (
                <Select ariaLabel="Team" value={idea.team?.key ?? "none"} options={[{ value: "none", label: "No team" }, ...teams.map((t) => ({ value: t.key, label: t.name }))]} onValueChange={(v) => change({ team: v === "none" ? null : v })} />
              ) : (
                <p>{idea.team?.name ?? "No team"}</p>
              )}
            </section>
            <section>
              <span className="label">Labels</span>
              <div className="flex flex-wrap gap-1.5">
                {idea.labels.map((l) => (
                  <span key={l} className="chip gap-1 bg-panel-2 py-1 text-xs text-fg">
                    {l}
                    {idea.canEdit && (
                      <button className="text-muted hover:text-fg" aria-label={`Remove label ${l}`} disabled={pending} onClick={() => change({ labels: idea.labels.filter((x) => x !== l) })}>
                        <CloseIcon />
                      </button>
                    )}
                  </span>
                ))}
                {idea.canEdit && (
                  <input
                    className="input !w-28 !py-0.5 text-xs"
                    aria-label="Add a label"
                    placeholder="+ label"
                    value={newLabel}
                    disabled={pending}
                    onChange={(e) => setNewLabel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" || !newLabel.trim()) return;
                      e.preventDefault();
                      change({ labels: [...idea.labels, newLabel] }, () => setNewLabel(""));
                    }}
                  />
                )}
              </div>
            </section>
            {idea.canEdit && !promoted && (
              <section>
                <button className="btn btn-primary w-full" disabled={pending || !idea.team || dirty} onClick={promote}>
                  Promote to issue
                </button>
                <p className="mt-1 text-xs text-muted">
                  {!idea.team ? "Tag a team to file it as an issue there." : dirty ? "Save your edit first." : `Files an issue in ${idea.team.name}.`}
                </p>
              </section>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
