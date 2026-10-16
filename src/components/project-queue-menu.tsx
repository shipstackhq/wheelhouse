import { requireHuman } from "@/lib/auth";
import { queueStatus } from "@wheelhouse/core/lib/service";
import { BotsMenu } from "./bots-menu";
import { Skeleton } from "./skeleton";

/** The header's bots menu while its numbers are still being worked out. */
export function BotsMenuFallback() {
  return <Skeleton className="h-8 w-24" />;
}

/**
 * The bots menu with its queue numbers. It is its own async component so the project header can render straight away and
 * this part streams in behind a placeholder (the queue query is the slowest thing the header needs).
 */
export async function ProjectQueueMenu({ projectKey }: { projectKey: string }) {
  const { actor } = await requireHuman();
  const queue = await queueStatus(actor, projectKey);
  return (
    <BotsMenu
      projectKey={projectKey}
      bots={queue.map((q) => ({
        id: q.id,
        name: q.name,
        pending: q.pending,
        sessions: q.sessions.map((x) => ({ ...x, lastSeenAt: x.lastSeenAt.toISOString() })),
        lastUsedAt: q.lastUsedAt ? new Date(q.lastUsedAt).toISOString() : null,
      }))}
    />
  );
}
