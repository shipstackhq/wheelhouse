"use client";

import { useEffect, useRef } from "react";
import { backoffMs, DEBOUNCE_MS, FALLBACK_POLL_MS, onStreamMessage, shouldFallBack, streamUrl } from "@/lib/live-stream";

/**
 * Keep a page fresh from the server's event stream (WH-1). `onSignal` runs (debounced) whenever something changed.
 * The stream is closed while the tab is hidden and reopened, with a catch-up from where it left off, when it is shown.
 * If the stream keeps failing it falls back to `poll` (a cheap "where is the log now" call) while retrying with backoff.
 */
export function useLiveStream({ path, onSignal, poll }: { path: string; onSignal: (seq: number | null) => void; poll?: () => Promise<number> }) {
  // The latest callbacks, without restarting the connection every render.
  const signal = useRef(onSignal);
  const pollRef = useRef(poll);
  useEffect(() => {
    signal.current = onSignal;
    pollRef.current = poll;
  });

  useEffect(() => {
    let alive = true;
    let es: EventSource | null = null;
    let last: number | null = null;
    let failures = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let poller: ReturnType<typeof setInterval> | null = null;
    let polled: number | null = null;

    const fire = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => alive && signal.current(last), DEBOUNCE_MS);
    };
    const stopPolling = () => {
      if (poller) clearInterval(poller);
      poller = null;
    };
    const startPolling = () => {
      if (poller || !pollRef.current) return;
      const tick = async () => {
        if (document.hidden || !pollRef.current) return;
        try {
          const seq = await pollRef.current();
          if (polled !== null && seq !== polled) fire();
          polled = seq;
        } catch {
          /* try next tick */
        }
      };
      void tick();
      poller = setInterval(tick, FALLBACK_POLL_MS);
    };
    const close = () => {
      es?.close();
      es = null;
      if (retry) clearTimeout(retry);
      retry = null;
    };
    const handle = (kind: "ready" | "resync" | "change") => (ev: MessageEvent) => {
      let seq: number | undefined;
      try {
        seq = JSON.parse(ev.data).seq ?? undefined;
      } catch {
        /* a payload we cannot read is still a reason to refresh */
      }
      failures = 0;
      stopPolling();
      const r = onStreamMessage(last, { kind, seq });
      last = r.last;
      if (r.refresh) fire();
    };
    const open = () => {
      if (!alive || document.hidden || es) return;
      es = new EventSource(streamUrl(path, last));
      es.addEventListener("ready", handle("ready"));
      es.addEventListener("resync", handle("resync"));
      es.addEventListener("change", handle("change"));
      es.onerror = () => {
        // We reconnect ourselves (with backoff and our own position) rather than leave it to the browser.
        close();
        failures++;
        if (shouldFallBack(failures)) startPolling();
        retry = setTimeout(open, backoffMs(failures));
      };
    };
    const onVisibility = () => {
      if (document.hidden) {
        close();
        stopPolling();
      } else {
        open();
        fire(); // catch up on whatever happened while the tab was hidden
      }
    };

    open();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisibility);
      close();
      stopPolling();
      if (debounce) clearTimeout(debounce);
    };
  }, [path]);
}
