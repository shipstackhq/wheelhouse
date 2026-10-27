import { useState, useTransition } from "react";
import { Link, useNavigate } from "../../lib/workspace";
import type { IdeaStatus, IdeaSummary } from "@wheelhouse/api-client";
import { SearchIcon } from "../../components/icons";
import { DescriptionEditor } from "../../components/description-editor";
import { Select } from "../../components/ui";
import { describeFailure } from "../../lib/form-state";
import { refreshAll } from "../../lib/refresh";
import { useServices } from "../../lib/services";
import { useTeams } from "../../lib/session";
import { IDEA_STATUSES, ideaStatusChip, when } from "./idea-bits";

/**
 * Every idea of the workspace as docs-style rows, newest first, filtered by status and searched by title. An idea is a note that is
 * not yet work: it has a title, rich text, an author and an optional team tag, and nothing else until it is promoted to an issue.
 */
export function Ideas(props: { ideas: IdeaSummary[] }) {
  const { api, queryClient } = useServices();
  const navigate = useNavigate();
  const teams = useTeams().data ?? [];
  const [filter, setFilter] = useState<IdeaStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ title: "", body: "", team: "" });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const needle = search.trim().toLowerCase();
  const shown = props.ideas.filter((i) => (filter === "all" || i.status === filter) && (!needle || i.title.toLowerCase().includes(needle)));

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
      <div className="mx-auto w-full max-w-4xl px-6 py-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Ideas</h2>
            <p className="mt-1 text-sm text-muted">A light place to capture what is not work yet. Promote an idea to an issue when it is ready to be committed to.</p>
          </div>
          <button className="btn btn-primary shrink-0" onClick={() => (setDraft({ title: "", body: "", team: "" }), setError(null), setCreating(true))}>
            + New idea
          </button>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by status">
            {(["all", ...IDEA_STATUSES] as const).map((s) => (
              <button key={s} type="button" aria-pressed={filter === s} className={filter === s ? "btn btn-primary" : "btn"} onClick={() => setFilter(s)}>
                {s}
              </button>
            ))}
          </div>
          <label className="relative ml-auto block">
            <SearchIcon className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-sm text-muted" />
            <input className="input !w-56 !pl-7" type="search" placeholder="Search titles" aria-label="Search ideas by title" value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
        </div>

        {creating && (
          <form
            className="mt-5 space-y-3 rounded-lg border border-accent/40 bg-panel/40 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              create();
            }}
          >
            <input
              className="w-full border-0 bg-transparent text-2xl font-semibold outline-none placeholder:text-muted/60"
              placeholder="What if…"
              aria-label="Title"
              value={draft.title}
              maxLength={200}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              autoFocus
            />
            <DescriptionEditor value={draft.body} onChange={(body) => setDraft((d) => ({ ...d, body }))} size="full" />
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

        {shown.length > 0 && (
          <ul className="mt-5 divide-y divide-line/70 rounded-lg border border-line/70">
            {shown.map((i) => (
              <li key={i.id}>
                <Link to={`/ideas/${i.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-panel/60">
                  <span className="min-w-0 flex-1 truncate font-medium">{i.title}</span>
                  {ideaStatusChip(i.status)}
                  <span className="text-xs text-muted">
                    {i.author.name}
                    {i.author.kind === "agent" && " (agent)"}
                  </span>
                  <span className="text-xs text-muted">{when(i.updatedAt)}</span>
                  <span className="text-xs text-muted">
                    {i.commentCount} comment{i.commentCount === 1 ? "" : "s"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {shown.length === 0 && !creating && (
          <p className="py-6 text-center text-sm text-muted">
            {props.ideas.length === 0 ? "No ideas yet. Capture the first one." : needle ? `No ideas match "${search.trim()}".` : `No ${filter} ideas.`}
          </p>
        )}
      </div>
    </div>
  );
}
