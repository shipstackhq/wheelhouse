import { useServices } from "../lib/services";
import { useLiveStream } from "./use-live-stream";

/**
 * Keeps the inbox fresh from the workspace stream, which also carries the person's own content-free `inbox.changed` signal (the
 * only stream that reaches items that belong to no team). It reads nothing from the signal: it just reads the inbox again.
 */
export function InboxLiveRefresh() {
  const { queryClient } = useServices();
  useLiveStream({ path: "/api/stream", onSignal: () => void queryClient.invalidateQueries({ queryKey: ["inbox"] }) });
  return null;
}
