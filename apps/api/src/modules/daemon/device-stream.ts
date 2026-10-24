import { and, asc, eq, gt } from "drizzle-orm";
import { getDb, schema } from "../../db";
import { serverSigningKey, signValue } from "./daemon-crypto";
import { bus } from "../../lib/event-bus";
import { type Q } from "../../lib/service";

/** A device's stream: who is listening, the signed messages sent to it, and the stream itself (SSE with replay). See wheelhouse-cli/daemon/DESIGN.md. */
const { devices, deviceMessages } = schema;

export type Listener = () => void;
export const g = globalThis as unknown as { __whDeviceListeners?: Map<string, Set<Listener>> };
export const listeners = (g.__whDeviceListeners ??= new Map());

export function listen(deviceId: string, fn: Listener) {
  let set = listeners.get(deviceId);
  if (!set) listeners.set(deviceId, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (!set!.size) listeners.delete(deviceId);
  };
}
/** Tell the device's open stream that new messages are in the log. Call it after the write has committed. */
export function wake(deviceId: string) {
  for (const fn of [...(listeners.get(deviceId) ?? [])]) fn();
}

/** A job changed: tell the browsers watching its team, so the issue's run list refreshes (a transient signal, not in the log). */
export const lastSignal = new Map<string, number>();
export function signalJob(job: { id: string; workspaceId: string; teamId: string; issueId: string }, throttleMs = 0) {
  const now = Date.now();
  if (throttleMs && now - (lastSignal.get(job.id) ?? 0) < throttleMs) return;
  lastSignal.set(job.id, now);
  if (lastSignal.size > 5_000) lastSignal.clear();
  bus.publish({ workspaceId: job.workspaceId, teamId: job.teamId, type: "job.updated", entity: "issue", entityId: job.issueId });
}

export type MessageType = (typeof schema.DEVICE_MESSAGE_TYPES)[number];
export type SigningKey = Awaited<ReturnType<typeof serverSigningKey>>;

/**
 * Append a signed message to the device's log. The signature covers the whole `message`, which names the device and the time, so a
 * message cannot be replayed to another machine. The caller loads `key` before opening its transaction: loading it the first time reads
 * the database, which inside a transaction on the single-connection embedded database would wait for itself forever.
 */
export async function sendToDevice(q: Q, key: SigningKey, deviceId: string, type: MessageType, body: Record<string, unknown>) {
  const { privateKey } = key;
  const message = { ...body, type, deviceId, issuedAt: new Date().toISOString() };
  await q.insert(deviceMessages).values({ deviceId, type, message, signature: signValue(privateKey, message) });
  return deviceId;
}

export const formatMessage = (m: typeof deviceMessages.$inferSelect) => `id: ${m.seq}\nevent: ${m.type}\ndata: ${JSON.stringify({ message: m.message, signature: m.signature })}\n\n`;

export const DEVICE_STREAM_HEARTBEAT_MS = 25_000;
export const DEVICE_STREAM_RECHECK_MS = 15_000;
export const REPLAY_LIMIT = 500;

/**
 * The device's stream: every message after `since` (its Last-Event-ID; null is the start of its log), then new ones as they are
 * written. It ends when the device is revoked or `signal` aborts. Messages are read from the table, never from memory, so a message
 * written while the stream was down is sent on reconnect.
 */
export function deviceStream(deviceId: string, since: number | null, signal: AbortSignal, opts: { heartbeatMs?: number; recheckMs?: number } = {}): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let last = since ?? 0;
  let closed = false;
  let pumping = false;
  let again = false;
  const timers: ReturnType<typeof setInterval>[] = [];
  let unlisten: (() => void) | null = null;
  let ctl: ReadableStreamDefaultController<Uint8Array>;

  const close = () => {
    if (closed) return;
    closed = true;
    unlisten?.();
    timers.forEach(clearInterval);
    signal.removeEventListener("abort", close);
    try {
      ctl.close();
    } catch {
      /* the client already went away */
    }
  };
  const send = (text: string) => {
    if (closed) return;
    try {
      ctl.enqueue(enc.encode(text));
    } catch {
      close();
    }
  };
  // Send whatever is new. Wakes that arrive while a read is running are folded into one more read.
  const pump = async () => {
    if (pumping) {
      again = true;
      return;
    }
    pumping = true;
    try {
      do {
        again = false;
        const db = await getDb();
        const rows = await db.select().from(deviceMessages).where(and(eq(deviceMessages.deviceId, deviceId), gt(deviceMessages.seq, last))).orderBy(asc(deviceMessages.seq)).limit(REPLAY_LIMIT);
        for (const r of rows) {
          send(formatMessage(r));
          last = r.seq;
        }
        if (rows.length === REPLAY_LIMIT) again = true;
      } while (again && !closed);
    } catch {
      /* the database hiccuped: the next wake or heartbeat tries again */
    } finally {
      pumping = false;
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      ctl = controller;
      if (signal.aborted) return close();
      signal.addEventListener("abort", close);
      send("retry: 5000\n\n");
      unlisten = listen(deviceId, () => void pump());
      timers.push(setInterval(() => {
        send(": keep-alive\n\n");
        void pump(); // also catches a message written by another process
      }, opts.heartbeatMs ?? DEVICE_STREAM_HEARTBEAT_MS));
      timers.push(setInterval(async () => {
        try {
          const db = await getDb();
          const [d] = await db.select({ revokedAt: devices.revokedAt }).from(devices).where(eq(devices.id, deviceId));
          if (!d || d.revokedAt) close();
        } catch {
          /* keep the stream; the next check tries again */
        }
      }, opts.recheckMs ?? DEVICE_STREAM_RECHECK_MS));
      void pump();
    },
    cancel() {
      close();
    },
  });
}

/** The position a device resumes from: its Last-Event-ID header. */
export function parseLastEventId(v: string | null | undefined): number | null {
  return v != null && /^\d{1,15}$/.test(v.trim()) ? Number(v.trim()) : null;
}
