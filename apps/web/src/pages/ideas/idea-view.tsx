import { useState, useTransition } from "react";
import { Link } from "../../lib/workspace";
import type { IdeaDetail, IdeaStatus } from "@wheelhouse/api-client";
import { Select } from "../../components/ui";
import { describeFailure } from "../../lib/form-state";
import { refreshAll } from "../../lib/refresh";
import { useServices } from "../../lib/services";
import { useTeams } from "../../lib/session";
import { SETTABLE_STATUSES, ideaStatusChip, issueHref, when } from "./idea-bits";

/** One idea: its text, a status to move it along, the discussion, and Promote, which files it as an issue and links the two. */
export function IdeaView(props: { idea: IdeaDetail }) {
  const { idea } = props;
  const { api, queryClient } = useServices();
  const teams = useTeams().data ?? [];
  const [comment, setComment] = useState("");
  const [team, setTeam] = useState(idea.team?.key ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = (fn: () => Promise<unknown>, after?: () => void) =>
    start(async () => {
      try {
        await fn();
        setError(null);
        after?.();
        await refreshAll(queryClient);
      } catch (e) {
        setError(describeFailure(e));
      }
    });

  const promoted = idea.status === "promoted";
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-6">
        <Link to="/ideas" className="text-sm text-muted hover:text-fg">← Ideas</Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">{idea.title}</h2>
          {ideaStatusChip(idea.status)}
          {idea.team && <span className="chip bg-panel-2 text-muted">{idea.team.name}</span>}
        </div>
        <p className="mt-1 text-sm text-muted">
          {idea.author.name}
          {idea.author.kind === "agent" && " (agent)"} · {when(idea.createdAt)}
        </p>
        {idea.body && <p className="mt-4 whitespace-pre-wrap text-sm">{idea.body}</p>}

        {idea.promotedIssue && (
          <p className="mt-4 rounded-md border border-ok/40 bg-ok/10 p-3 text-sm">
            Promoted to{" "}
            <Link to={issueHref(idea.promotedIssue.ref)} className="font-semibold hover:underline">
              {idea.promotedIssue.ref}
            </Link>{" "}
            · {idea.promotedIssue.title}
          </p>
        )}

        {idea.canEdit && !promoted && (
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <label className="block text-xs text-muted">
              Status
              <Select ariaLabel="Status" value={idea.status} options={SETTABLE_STATUSES.map((s) => ({ value: s, label: s }))} onValueChange={(v) => run(() => api.ideas.update(idea.id, { status: v as Exclude<IdeaStatus, "promoted"> }))} />
            </label>
            <label className="block text-xs text-muted">
              Promote into team
              <Select ariaLabel="Team" value={team || "none"} options={[{ value: "none", label: "Choose a team" }, ...teams.map((t) => ({ value: t.key, label: t.name }))]} onValueChange={(v) => setTeam(v === "none" ? "" : v)} />
            </label>
            <button className="btn btn-primary" disabled={pending || !team} onClick={() => run(() => api.ideas.promote(idea.id, team))}>
              Promote to issue
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
              <p className="mt-1 whitespace-pre-wrap text-sm">{c.body}</p>
            </div>
          ))}
        </div>
        {idea.canEdit && (
          <form
            className="mt-3 space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (comment.trim()) run(() => api.ideas.comment(idea.id, comment.trim()), () => setComment(""));
            }}
          >
            <textarea className="input min-h-20" placeholder="Add a comment" aria-label="Comment" value={comment} onChange={(e) => setComment(e.target.value)} />
            <button type="submit" className="btn" disabled={pending || !comment.trim()}>
              Comment
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
