import Link from "next/link";
import { notFound } from "next/navigation";
import { requireHuman } from "@/lib/auth";
import { getIdea, listProjects, ServiceError } from "@/lib/service";
import { IDEA_STATUSES } from "@/db/schema";
import { commentIdeaAction, promoteIdeaAction, setIdeaStatusAction } from "../../../actions";
import { Markdown } from "@/components/markdown";
import { timeAgo } from "@/lib/time";

export default async function IdeaPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { id } = await params;
  const { error } = await searchParams;
  const { actor } = await requireHuman();
  let data;
  try {
    data = await getIdea(actor, id);
  } catch (e) {
    if (e instanceof ServiceError && e.code === "not_found") notFound();
    throw e;
  }
  const { idea, comments, ticket } = data;
  const projects = await listProjects(actor);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 px-6 py-10">
        <Link href="/ideas" className="text-xs text-muted hover:text-fg">← Ideas</Link>
        <div>
          <h1 className="text-xl font-semibold">{idea.title}</h1>
          <div className="mt-1 text-xs text-muted">
            {idea.authorName}
            {idea.authorKind === "agent" ? " (agent)" : ""} · {timeAgo(idea.createdAt)}
            {idea.tag ? ` · #${idea.tag}` : ""}
          </div>
        </div>
        {error && <p className="text-sm text-red-500">{error}</p>}

        {idea.body && <div className="card p-4"><Markdown>{idea.body}</Markdown></div>}

        <div className="card space-y-4 p-4 text-sm">
          <form action={setIdeaStatusAction} className="flex items-center gap-2">
            <input type="hidden" name="id" value={idea.id} />
            <span className="text-muted">Status</span>
            <select name="status" defaultValue={idea.status} className="input w-36 py-1.5">
              {IDEA_STATUSES.filter((s) => s !== "promoted" || idea.status === "promoted").map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <button className="btn">Save</button>
          </form>

          {ticket ? (
            <div>
              <span className="text-muted">Promoted to </span>
              <Link href={`/p/${ticket.ref.split("-")[0]}?t=${ticket.ref}`} className="font-mono underline">{ticket.ref}</Link>
              <span className="text-muted"> {ticket.title}</span>
            </div>
          ) : projects.length === 0 ? (
            <p className="text-muted">Create a project to promote this idea to an issue.</p>
          ) : (
            <form action={promoteIdeaAction} className="flex items-center gap-2">
              <input type="hidden" name="id" value={idea.id} />
              <span className="text-muted">Promote to an issue in</span>
              <select name="project" className="input w-48 py-1.5">
                {projects.map((p) => (
                  <option key={p.id} value={p.key}>{p.name} ({p.key})</option>
                ))}
              </select>
              <button className="btn">Promote</button>
            </form>
          )}
        </div>

        <div className="space-y-3">
          <h2 className="font-medium">Comments</h2>
          {comments.map((c) => (
            <div key={c.id} className="card p-3 text-sm">
              <div className="text-xs text-muted">
                {c.authorName}
                {c.authorKind === "agent" ? " (agent)" : ""} · {timeAgo(c.createdAt)}
              </div>
              <div className="mt-1"><Markdown>{c.body}</Markdown></div>
            </div>
          ))}
          <form action={commentIdeaAction} className="space-y-2">
            <input type="hidden" name="id" value={idea.id} />
            <textarea name="body" required rows={2} placeholder="Add a comment" className="input w-full" />
            <button className="btn">Comment</button>
          </form>
        </div>
      </div>
    </div>
  );
}
