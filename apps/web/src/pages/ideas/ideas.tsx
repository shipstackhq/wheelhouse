import { useState, useTransition } from "react";
import { Link, useNavigate } from "../../lib/workspace";
import type { IdeaStatus, IdeaSummary } from "@wheelhouse/api-client";
import { Select } from "../../components/ui";
import { describeFailure } from "../../lib/form-state";
import { refreshAll } from "../../lib/refresh";
import { useServices } from "../../lib/services";
import { useTeams } from "../../lib/session";
import { IDEA_STATUSES, ideaStatusChip, when } from "./idea-bits";

/**
 * Every idea of the workspace, newest first, filtered by status. An idea is a note that is not yet work: it has a title, some text, an
 * author and an optional team tag, and nothing else until it is promoted to an issue.
 */
export function Ideas(props: { ideas: IdeaSummary[] }) {
  const { api, queryClient } = useServices();
  const navigate = useNavigate();
  const teams = useTeams().data ?? [];
  const [filter, setFilter] = useState<IdeaStatus | "all">("all");
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ title: "", body: "", team: "" });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const shown = filter === "all" ? props.ideas : props.ideas.filter((i) => i.status === filter);

  const create = () =>
    start(async () => {
      if (!draft.title.trim()) return setError("An idea needs a title.");
      try {
        const idea = await api.ideas.create({ title: draft.title.trim(), body: draft.body.trim(), team: draft.team || null });
        await refreshAll(queryClient);
        navigate(`/ideas/${idea.id}`);
      } catch (e) {
        setError(describeFailure(e));
      }
    });

  return (
    <div className="h-full overflow-y-auto">
      <div className="w-full px-6 py-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Ideas</h2>
            <p className="mt-1 text-sm text-muted">A light place to capture what is not work yet. Promote an idea to an issue when it is ready to be committed to.</p>
          </div>
          <button className="btn btn-primary shrink-0" onClick={() => (setDraft({ title: "", body: "", team: "" }), setError(null), setCreating(true))}>
            + New idea
          </button>
        </div>
        <div className="mt-4 flex flex-wrap gap-1" role="group" aria-label="Filter by status">
          {(["all", ...IDEA_STATUSES] as const).map((s) => (
            <button key={s} type="button" aria-pressed={filter === s} className={filter === s ? "btn btn-primary" : "btn"} onClick={() => setFilter(s)}>
              {s}
            </button>
          ))}
        </div>
        <div className="mt-5 space-y-2">
          {creating && (
            <form
              className="space-y-2 rounded-md border border-accent/40 bg-panel p-3"
              onSubmit={(e) => {
                e.preventDefault();
                create();
              }}
            >
              <input className="input" placeholder="What if…" aria-label="Title" value={draft.title} maxLength={200} onChange={(e) => setDraft({ ...draft, title: e.target.value })} autoFocus />
              <textarea className="input min-h-24" placeholder="Say more (optional)" aria-label="Details" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
              {teams.length > 0 && (
                <label className="block text-xs text-muted">
                  Team (optional tag)
                  <Select ariaLabel="Team" value={draft.team || "none"} options={[{ value: "none", label: "No team" }, ...teams.map((t) => ({ value: t.key, label: t.name }))]} onValueChange={(v) => setDraft({ ...draft, team: v === "none" ? "" : v })} />
                </label>
              )}
              {error && <p className="text-sm text-danger" role="alert">{error}</p>}
              <div className="flex gap-2">
                <button type="submit" className="btn btn-primary" disabled={pending}>
                  Add idea
                </button>
                <button type="button" className="btn" onClick={() => (setCreating(false), setError(null))}>
                  Cancel
                </button>
              </div>
            </form>
          )}
          {shown.length === 0 && !creating && (
            <p className="py-6 text-center text-sm text-muted">{props.ideas.length === 0 ? "No ideas yet. Capture the first one." : `No ${filter} ideas.`}</p>
          )}
          {shown.map((i) => (
            <Link key={i.id} to={`/ideas/${i.id}`} className="card block px-4 py-3 hover:border-muted/50">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{i.title}</span>
                {ideaStatusChip(i.status)}
                {i.team && <span className="chip bg-panel-2 text-muted">{i.team.name}</span>}
              </div>
              <p className="mt-1 text-sm text-muted">
                {i.author.name}
                {i.author.kind === "agent" && " (agent)"} · {when(i.createdAt)} · {i.commentCount} comment{i.commentCount === 1 ? "" : "s"}
                {i.promotedIssue && ` · issue ${i.promotedIssue.ref}`}
              </p>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
