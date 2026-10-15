"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useLiveStream } from "@/components/use-live-stream";

/**
 * Re-render the dashboard when anything changes in the team (the server's event stream, WH-1), and every 30s while the tab
 * is visible as a safety net for anything the stream does not carry (and on refocus).
 */
export function DashboardRefresh({ intervalMs = 30_000 }: { intervalMs?: number }) {
  const router = useRouter();
  useLiveStream({ path: "/api/stream", onSignal: () => router.refresh() });
  useEffect(() => {
    const tick = () => !document.hidden && router.refresh();
    const id = setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [router, intervalMs]);
  return null;
}
