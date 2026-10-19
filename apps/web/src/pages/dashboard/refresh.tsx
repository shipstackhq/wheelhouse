import { useEffect } from "react";
import { useServices } from "../../lib/services";
import { WorkspaceLiveRefresh } from "../../components/live-refresh";

/**
 * Keep the dashboard fresh: the workspace's event stream (WH-1) refreshes it the moment anything changes, and every 30s while the tab is
 * visible (and on refocus) as a safety net for anything the stream does not carry.
 */
export function DashboardRefresh({ intervalMs = 30_000, stream = true }: { intervalMs?: number; /** False inside a project, whose own stream already refreshes everything on screen. */ stream?: boolean }) {
  const { queryClient } = useServices();
  useEffect(() => {
    const tick = () => !document.hidden && void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    const id = setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [queryClient, intervalMs]);
  return stream ? <WorkspaceLiveRefresh /> : null;
}
