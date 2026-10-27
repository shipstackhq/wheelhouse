import Link from "next/link";
import clsx from "clsx";
import { requireHuman } from "@/lib/auth";
import { listIdeas, type IdeaStatus } from "@/lib/service";
import { IDEA_STATUSES } from "@/db/schema";
import { createIdeaAction } from "../../actions";
import { timeAgo } from "@/lib/time";

export default async function IdeasPage({ searchParams }: { searchParams: Promise<{ status?: string; error?: string }> }) {
  const { actor } = await requireHuman();
  const sp = await searchParams;
  const status = (IDEA_STATUSES as readonly string[]).includes(sp.status ?? "") ? (sp.status as IdeaStatus) : undefined;
  const ideas = await listIdeas(actor, { status });

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 px-6 py-10">
        <div>
          <h1 className="text-xl font-semibold">Ideas</h1>
          <p className="mt-1 text-sm text-muted">
            Capture an idea before it is work. Docs hold what is decided and issues hold what is committed; promote an idea to an issue when it is ready.
          </p>
        </div>

        <form action={createIdeaAction} className="card space-y-3 p-4">
          <input name="title" required placeholder="Idea title" className="input w-full" />
          <textarea name="body" rows={3} placeholder="Describe it (markdown)" className="input w-full" />
          <div className="flex items-center gap-3">
            <input name="tag" placeholder="Team tag (optional)" className="input w-48" />
            <button className="btn ml-auto">Add idea</button>
          </div>
          {sp.error && <p className="text-sm text-red-500">{sp.error}</p>}
        </form>

        <div className="flex flex-wrap gap-2 text-sm">
          <Link href="/ideas" className={clsx("rounded-md px-2 py-1", !status ? "bg-panel-2 text-fg" : "text-muted hover:text-fg")}>All</Link>
          {IDEA_STATUSES.map((s) => (
            <Link key={s} href={`/ideas?status=${s}`} className={clsx("rounded-md px-2 py-1", status === s ? "bg-panel-2 text-fg" : "text-muted hover:text-fg")}>
              {s}
            </Link>
          ))}
        </div>

        {ideas.length === 0 ? (
          <p className="text-sm text-muted">No ideas{status ? ` that are ${status}` : ""} yet.</p>
        ) : (
          <div className="card divide-y divide-line">
            {ideas.map((i) => (
              <Link key={i.id} href={`/ideas/${i.id}`} className="block px-4 py-3 text-sm hover:bg-panel-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate font-medium">{i.title}</span>
                  <span className="shrink-0 text-xs text-muted">{i.status}</span>
                </div>
                <div className="mt-0.5 text-xs text-muted">
                  {i.authorName}
                  {i.authorKind === "agent" ? " (agent)" : ""} · {timeAgo(i.createdAt)}
                  {i.tag ? ` · #${i.tag}` : ""}
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
