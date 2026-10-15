"use client";

import { useRouter } from "next/navigation";
import { latestSeq } from "@/app/actions";
import { useLiveStream } from "./use-live-stream";

/**
 * Re-renders the page when anyone (human or agent) changes the project, and tells the panels that keep their own copy of
 * the data (ticket dialog, map, glossary...) with a `wheelhouse:changed` browser event. Driven by the server's event
 * stream (WH-1); it only polls if the stream is not getting through.
 */
export function LiveRefresh({ projectKey }: { projectKey: string }) {
  const router = useRouter();
  useLiveStream({
    path: `/api/projects/${encodeURIComponent(projectKey)}/stream`,
    poll: () => latestSeq(projectKey),
    onSignal: (seq) => {
      router.refresh();
      window.dispatchEvent(new CustomEvent("wheelhouse:changed", { detail: { seq } }));
    },
  });
  return null;
}
