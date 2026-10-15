/** Pure rules for the browser side of the live stream (WH-1), so they can be tested without a browser. */

/** Bursts of changes (an agent writing ten things) become one refresh. */
export const DEBOUNCE_MS = 250;
/** After this many failures in a row the stream is not working here (a proxy that buffers, say): poll while still retrying it. */
export const FALLBACK_AFTER = 3;
export const FALLBACK_POLL_MS = 10_000;

/** Wait before reconnecting: 1s, 2s, 4s ... capped at 30s. `failures` counts the failures so far (1 for the first). */
export function backoffMs(failures: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, failures - 1));
}

export const shouldFallBack = (failures: number) => failures >= FALLBACK_AFTER;

export type Incoming = { kind: "ready" | "resync" | "change"; seq?: number };

/**
 * Turn what the stream said into what the page should do. `last` is the highest log position seen so far.
 * `refresh` is true when the page should re-read its data now; the first `ready` only records where the log is.
 */
export function onStreamMessage(last: number | null, m: Incoming): { last: number | null; refresh: boolean } {
  const seq = m.seq ?? null;
  const next = seq == null ? last : Math.max(last ?? 0, seq);
  if (m.kind === "ready") return { last: next, refresh: last !== null && seq !== null && seq > last }; // reconnected and missed something
  return { last: next, refresh: true }; // a change, a resync, or a queue signal
}

export const streamUrl = (path: string, since: number | null) => (since == null ? path : `${path}?since=${since}`);
