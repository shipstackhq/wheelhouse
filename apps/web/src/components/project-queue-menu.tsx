import { useQuery } from "@tanstack/react-query";
import { queueQuery } from "../lib/queries";
import { useServices } from "../lib/services";
import { BotsMenu } from "./bots-menu";
import { Skeleton } from "./skeleton";

/** The header's bots menu while its numbers are still being worked out. */
export function BotsMenuFallback() {
  return <Skeleton className="h-8 w-8 !rounded-full" />;
}

/**
 * The bots menu with its queue numbers. It loads on its own, so the project header draws at once and this part fills in behind
 * a placeholder (the queue query is the slowest thing the header needs). If it cannot load, the rest of the page still works.
 */
export function ProjectQueueMenu({ projectKey }: { projectKey: string }) {
  const { api } = useServices();
  const q = useQuery(queueQuery(api, projectKey));
  if (q.isPending) return <BotsMenuFallback />;
  if (q.isError) return null;
  return <BotsMenu projectKey={projectKey} bots={q.data} />;
}
