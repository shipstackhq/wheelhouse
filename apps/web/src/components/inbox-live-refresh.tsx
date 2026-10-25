import { useServices } from "../lib/services";
import { useLiveStream } from "./use-live-stream";

/**
 * Keeps the inbox fresh from the workspace stream, which also carries the person's own content-free `inbox.changed` signal (the
 * only stream that reaches items that belong to no team), and the person's `chat.updated` signal for their chats. It reads nothing from
 * a signal: it just reads the inbox and the chats again (a chat nobody has open costs nothing).
 */
export function InboxLiveRefresh() {
  const { queryClient } = useServices();
  useLiveStream({
    path: "/api/stream",
    onSignal: () => {
      void queryClient.invalidateQueries({ queryKey: ["inbox"] });
      void queryClient.invalidateQueries({ queryKey: ["chats"] });
    },
  });
  return null;
}
