import Link from "next/link";
import clsx from "clsx";
import { requireHuman } from "@/lib/auth";
import { getProject, listEvents } from "@wheelhouse/core/lib/service";
import { timeAgo } from "@wheelhouse/core/lib/time";

export default async function ActivityPage({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: Promise<{ who?: string }> }) {
  const { key } = await params;
  const { who } = await searchParams;
  const { actor } = await requireHuman();
  const project = await getProject(actor, key);
  const actorKind = who === "agent" || who === "human" ? who : undefined;
  const events = await listEvents(actor, key, { limit: 200, actorKind });
  const tab = (v: string | undefined, label: string) => (
    <Link
      href={v ? `?who=${v}` : "?"}
      className={clsx("rounded-md px-3 py-1 text-sm", actorKind === v ? "bg-panel-2 text-fg" : "text-muted hover:text-fg")}
    >
      {label}
    </Link>
  );
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <div className="mb-4 flex gap-1">
          {tab(undefined, "Everything")}
          {tab("agent", "🤖 Agents")}
          {tab("human", "Team")}
        </div>
        {events.length === 0 && <p className="text-sm text-muted">Nothing yet.</p>}
        <ul className="divide-y divide-line">
          {events.map((e) => {
            const ref = typeof e.data?.ref === "string" ? e.data.ref : null;
            return (
              <li key={e.seq} className="flex items-baseline gap-3 py-2.5 text-sm">
                <span className="w-14 shrink-0 font-mono text-[11px] text-muted/70">#{e.seq}</span>
                <span className={clsx("shrink-0 font-medium", e.actorKind === "agent" && "text-agent")}>
                  {e.actorKind === "agent" ? "🤖 " : ""}
                  {e.actorName}
                </span>
                <span className="min-w-0 flex-1 text-muted">
                  {ref ? (
                    <Link href={`/p/${project.key}?t=${ref}`} className="hover:text-fg">{e.summary}</Link>
                  ) : e.entity === "node" ? (
                    <Link href={`/p/${project.key}/map?node=${e.entityId}`} className="hover:text-fg">{e.summary}</Link>
                  ) : e.entity === "edge" || e.entity === "flow" || e.type === "code.changed" ? (
                    <Link href={`/p/${project.key}/map${e.entity === "flow" ? `?flow=${e.entityId}` : ""}`} className="hover:text-fg">{e.summary}</Link>
                  ) : e.entity === "decision" ? (
                    <Link href={`/p/${project.key}/decisions#adr-${e.data?.number ?? ""}`} className="hover:text-fg">{e.summary}</Link>
                  ) : e.entity === "term" ? (
                    <Link href={`/p/${project.key}/glossary`} className="hover:text-fg">{e.summary}</Link>
                  ) : (
                    e.summary
                  )}
                  {e.type === "comment.created" && typeof e.data?.body === "string" && (
                    <span className="mt-1 block truncate text-xs text-muted/80">“{e.data.body}”</span>
                  )}
                </span>
                <span className="shrink-0 text-xs text-muted/70">{timeAgo(e.createdAt)}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
