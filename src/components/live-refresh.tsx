"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { latestSeq } from "@/app/actions";

/** Re-renders the page when anyone (human or agent) changes the project. */
export function LiveRefresh({ projectKey, intervalMs = 3000 }: { projectKey: string; intervalMs?: number }) {
  const router = useRouter();
  const last = useRef<number | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const seq = await latestSeq(projectKey);
        if (!alive) return;
        if (last.current !== null && seq !== last.current) {
          router.refresh();
          window.dispatchEvent(new CustomEvent("wheelhouse:changed", { detail: { seq } }));
        }
        last.current = seq;
      } catch {
        /* transient; try next tick */
      }
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [projectKey, intervalMs, router]);
  return null;
}
