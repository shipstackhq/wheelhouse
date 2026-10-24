import type { StreamEvent } from "../events/event-bus";

/** Idle connections are closed by proxies after a minute or so; a comment line this often keeps them open. */
export const HEARTBEAT_MS = 25_000;
/** More missed events than this and the browser is told to reload what it shows instead of being sent each one. */
export const REPLAY_CAP = 200;
/** How often an open stream asks whether its person may still hear it (removed from a team, say). Short enough that it does not matter. */
export const RECHECK_MS = 15_000;

const enc = new TextEncoder();

/** What the browser needs to decide what to refresh. The full data stays in the database. */
function payload(e: StreamEvent) {
  return { seq: e.seq, type: e.type, entity: e.entity, entityId: e.entityId, actorKind: e.actorKind, actorName: e.actorName, summary: e.summary };
}

/** A change from the log carries `id:` (so the browser can resume); a transient signal has none. */
export function formatChange(e: StreamEvent): string {
  return `${e.seq != null ? `id: ${e.seq}\n` : ""}event: change\ndata: ${JSON.stringify(payload(e))}\n\n`;
}
/** `ready` (first connect) and `resync` (too far behind) both just tell the browser where the log is now. */
export function formatMarker(name: "ready" | "resync", seq: number): string {
  return `id: ${seq}\nevent: ${name}\ndata: ${JSON.stringify({ seq })}\n\n`;
}
export const formatHeartbeat = () => `: keep-alive\n\n`;

/** The position a browser resumes from: the `Last-Event-ID` header EventSource sends, or `?since=` when we reconnect by hand. */
export function parseSince(header: string | null, query: string | null): number | null {
  for (const raw of [header, query]) {
    if (raw != null && /^\d{1,15}$/.test(raw.trim())) return Number(raw.trim());
  }
  return null;
}

export type StreamDeps = {
  /** Start listening for live changes; returns how to stop. */
  subscribe: (fn: (e: StreamEvent) => void) => () => void;
  /** Committed events with seq greater than `since`, oldest first; ask for one more than the cap to learn whether there are more. */
  replay: (since: number, limit: number) => Promise<StreamEvent[]>;
  /** Where the log is right now. */
  latestSeq: () => Promise<number>;
  since: number | null;
  signal: AbortSignal;
  heartbeatMs?: number;
  replayCap?: number;
  /**
   * Asked every `recheckMs` while the stream is open: false ends it (the browser reconnects and is judged afresh), true carries on.
   * An access check at connect time is not enough for a stream that can stay open for hours.
   */
  recheck?: () => Promise<boolean>;
  recheckMs?: number;
  /** Called exactly once when the stream ends for any reason. */
  onClose?: () => void;
};

/**
 * The body of a text/event-stream response. It subscribes before it replays, so nothing that happens during the replay
 * is lost, and de-duplicates by sequence so nothing is sent twice.
 */
export function eventStream(d: StreamDeps): ReadableStream<Uint8Array> {
  const heartbeatMs = d.heartbeatMs ?? HEARTBEAT_MS;
  const cap = d.replayCap ?? REPLAY_CAP;
  let unsubscribe: (() => void) | null = null;
  let beat: ReturnType<typeof setInterval> | null = null;
  let checker: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  let lastSent = d.since ?? -1;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  const shutdown = () => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    if (beat) clearInterval(beat);
    if (checker) clearInterval(checker);
    d.signal.removeEventListener("abort", shutdown);
    try {
      controllerRef?.close();
    } catch {
      /* already closed by the client */
    }
    d.onClose?.();
  };

  const send = (text: string) => {
    if (closed) return;
    try {
      controllerRef!.enqueue(enc.encode(text));
    } catch {
      shutdown(); // the client went away between events
    }
  };

  const live = (e: StreamEvent) => {
    if (e.seq != null) {
      if (e.seq <= lastSent) return;
      lastSent = e.seq;
    }
    send(formatChange(e));
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controllerRef = controller;
      if (d.signal.aborted) return shutdown();
      d.signal.addEventListener("abort", shutdown);
      send("retry: 3000\n\n");

      // Events that arrive while we replay are held, then sent in order.
      const held: StreamEvent[] = [];
      let replaying = true;
      unsubscribe = d.subscribe((e) => (replaying ? held.push(e) : live(e)));
      beat = setInterval(() => send(formatHeartbeat()), heartbeatMs);
      if (d.recheck) {
        let checking = false;
        checker = setInterval(async () => {
          if (checking || closed) return;
          checking = true;
          try {
            if (!(await d.recheck!())) shutdown();
          } catch {
            /* the database hiccuped: keep the stream, the next check will try again */
          } finally {
            checking = false;
          }
        }, d.recheckMs ?? RECHECK_MS);
      }

      try {
        if (d.since == null) {
          const now = await d.latestSeq();
          lastSent = Math.max(lastSent, now);
          send(formatMarker("ready", now));
        } else {
          const rows = await d.replay(d.since, cap + 1);
          if (rows.length > cap) {
            const now = await d.latestSeq();
            lastSent = Math.max(lastSent, now);
            send(formatMarker("resync", now));
          } else if (rows.length === 0) {
            // Nothing newer. If the log is *behind* the browser (a restored backup, a reset dev database), its position means
            // nothing here: tell it to start over from where the log is.
            const now = await d.latestSeq();
            if (now < d.since) {
              lastSent = now;
              send(formatMarker("resync", now));
            }
          } else {
            for (const r of rows) live(r);
          }
        }
      } catch {
        // The database hiccuped: tell the browser to reload what it shows, then carry on live.
        send(formatMarker("resync", Math.max(lastSent, 0)));
      }
      replaying = false;
      for (const e of held) live(e);
    },
    cancel() {
      shutdown();
    },
  });
}

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no", // nginx-style proxies: do not buffer
} as const;
