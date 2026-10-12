"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Re-render the dashboard every 30s while the tab is visible (and on refocus). */
export function DashboardRefresh({ intervalMs = 30_000 }: { intervalMs?: number }) {
  const router = useRouter();
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
