import { useRef } from "react";
import { useServices } from "../lib/services";
import { useLiveStream } from "./use-live-stream";

/**
 * Keeps what is on screen fresh when anyone (a person or an agent) changes something. When the server's event stream (WH-1)
 * reports a change, every query on screen is read again, and the panels that keep their own copy of some data (the ticket
 * dialog, the map, the glossary...) are told with a `wheelhouse:changed` browser event. If the stream is not getting through
 * it falls back to reading again every few seconds.
 */
export function LiveRefresh({ path }: { path: string }) {
  const { queryClient } = useServices();
  const polls = useRef(0);
  useLiveStream({
    path,
    // Used only while the stream is down: each poll reports a new number, which counts as "something may have changed".
    poll: async () => ++polls.current,
    onSignal: (seq) => {
      void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "me" });
      window.dispatchEvent(new CustomEvent("wheelhouse:changed", { detail: { seq } }));
    },
  });
  return null;
}

/** One project's changes (the project pages). */
export const ProjectLiveRefresh = ({ projectKey }: { projectKey: string }) => <LiveRefresh path={`/api/projects/${encodeURIComponent(projectKey)}/stream`} />;

/** Everything in the signed-in workspace (the dashboard). */
export const WorkspaceLiveRefresh = () => <LiveRefresh path="/api/stream" />;
