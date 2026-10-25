import crypto from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { schema } from "../../db";
import { bus } from "../../platform/events/event-bus";
import { rawPublicKey, signValue } from "./daemon-crypto";
import { DaemonRepository } from "./daemon.repository";
import { formatMessage } from "./daemon.presenter";

export type MessageType = (typeof schema.DEVICE_MESSAGE_TYPES)[number];
export type SigningKey = { privateKey: crypto.KeyObject; publicKey: crypto.KeyObject };

type Listener = () => void;
const g = globalThis as unknown as { __whDeviceListeners?: Map<string, Set<Listener>>; __whDaemonKey?: Promise<SigningKey> };
/** The open streams by device id, shared by every copy of this module in the process. */
const listeners = (g.__whDeviceListeners ??= new Map());
/** When each job last told the browsers it changed, to throttle the noisy ones. */
const lastSignal = new Map<string, number>();

const SIGNING_KEY = "daemon_signing";
export const DEVICE_STREAM_HEARTBEAT_MS = 25_000;
export const DEVICE_STREAM_RECHECK_MS = 15_000;
export const REPLAY_LIMIT = 500;

/**
 * A device's stream: who is listening, the signed messages sent to it, the server's signing key, and the stream itself (SSE with
 * replay). Used by the machine side and by the person side, which sends a device its job offers and settings. See wheelhouse-cli/daemon/DESIGN.md.
 */
@Injectable()
export class DeviceStreamService {
  constructor(@Inject(DaemonRepository) private readonly repo: DaemonRepository) {}

  /**
   * The key the server signs device messages with. DAEMON_SIGNING_KEY (an Ed25519 private key, PKCS#8 DER in base64) wins; without it
   * the instance makes one the first time and keeps it in `instance_keys`, so a restart does not orphan paired devices (they pinned it).
   * Load it before opening a transaction: the first load reads the database, which inside a transaction on the single-connection
   * embedded database would wait for itself forever.
   */
  signingKey(): Promise<SigningKey> {
    return (g.__whDaemonKey ??= this.loadSigningKey().catch((e) => {
      g.__whDaemonKey = undefined;
      throw e;
    }));
  }

  private async loadSigningKey(): Promise<SigningKey> {
    const env = process.env.DAEMON_SIGNING_KEY?.trim();
    if (env) {
      const privateKey = crypto.createPrivateKey({ key: Buffer.from(env, "base64"), format: "der", type: "pkcs8" });
      if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("DAEMON_SIGNING_KEY must be an Ed25519 key");
      return { privateKey, publicKey: crypto.createPublicKey(privateKey) };
    }
    let row = await this.repo.instanceKey(SIGNING_KEY);
    if (!row) {
      const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
      await this.repo.insertInstanceKey({ name: SIGNING_KEY, privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"), publicKey: rawPublicKey(publicKey) });
      row = await this.repo.instanceKey(SIGNING_KEY); // another process may have won the race; everyone uses the stored one
    }
    const privateKey = crypto.createPrivateKey({ key: Buffer.from(row!.privateKey, "base64"), format: "der", type: "pkcs8" });
    return { privateKey, publicKey: crypto.createPublicKey(privateKey) };
  }

  /** Forget the cached key (tests that swap DAEMON_SIGNING_KEY, or act as after a restart). */
  resetSigningKey() {
    g.__whDaemonKey = undefined;
  }

  /**
   * Append a signed message to the device's log, on the current transaction if there is one. The signature covers the whole `message`,
   * which names the device and the time, so a message cannot be replayed to another machine. The caller loads `key` first (see `signingKey`).
   */
  async send(key: SigningKey, deviceId: string, type: MessageType, body: Record<string, unknown>) {
    const message = { ...body, type, deviceId, issuedAt: new Date().toISOString() };
    await this.repo.insertMessage({ deviceId, type, message, signature: signValue(key.privateKey, message) });
  }

  /** Tell the device's open stream that new messages are in the log. Call it after the write has committed. */
  wake(deviceId: string) {
    for (const fn of [...(listeners.get(deviceId) ?? [])]) fn();
  }

  /** A job changed: tell the browsers watching its team, so the issue's run list refreshes (a transient signal, not in the log). */
  signalJob(job: { id: string; workspaceId: string; teamId: string; issueId: string }, throttleMs = 0) {
    const now = Date.now();
    if (throttleMs && now - (lastSignal.get(job.id) ?? 0) < throttleMs) return;
    lastSignal.set(job.id, now);
    if (lastSignal.size > 5_000) lastSignal.clear();
    bus.publish({ workspaceId: job.workspaceId, teamId: job.teamId, type: "job.updated", entity: "issue", entityId: job.issueId });
  }

  /** A chat thread changed: tell its owner's browsers (a transient signal). Deltas are throttled; a state change goes at once. */
  signalChat(thread: { id: string; workspaceId: string; teamId: string; ownerId: string }, throttleMs = 0) {
    const now = Date.now();
    if (throttleMs && now - (lastSignal.get(thread.id) ?? 0) < throttleMs) return;
    lastSignal.set(thread.id, now);
    if (lastSignal.size > 5_000) lastSignal.clear();
    bus.publish({ workspaceId: thread.workspaceId, teamId: thread.teamId, type: "chat.updated", entity: "chat", entityId: thread.id, recipientUserId: thread.ownerId });
  }

  private listen(deviceId: string, fn: Listener) {
    let set = listeners.get(deviceId);
    if (!set) listeners.set(deviceId, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (!set!.size) listeners.delete(deviceId);
    };
  }

  /**
   * The device's stream: every message after `since` (its Last-Event-ID; null is the start of its log), then new ones as they are
   * written. It ends when the device is revoked or `signal` aborts. Messages are read from the table, never from memory, so a message
   * written while the stream was down is sent on reconnect.
   */
  stream(deviceId: string, since: number | null, signal: AbortSignal, opts: { heartbeatMs?: number; recheckMs?: number } = {}): ReadableStream<Uint8Array> {
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
          const rows = await this.repo.messagesAfter(deviceId, last, REPLAY_LIMIT);
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
      start: (controller) => {
        ctl = controller;
        if (signal.aborted) return close();
        signal.addEventListener("abort", close);
        send("retry: 5000\n\n");
        unlisten = this.listen(deviceId, () => void pump());
        timers.push(
          setInterval(() => {
            send(": keep-alive\n\n");
            void pump(); // also catches a message written by another process
          }, opts.heartbeatMs ?? DEVICE_STREAM_HEARTBEAT_MS),
        );
        timers.push(
          setInterval(async () => {
            try {
              const d = await this.repo.deviceRevokedAt(deviceId);
              if (!d || d.revokedAt) close();
            } catch {
              /* keep the stream; the next check tries again */
            }
          }, opts.recheckMs ?? DEVICE_STREAM_RECHECK_MS),
        );
        void pump();
      },
      cancel() {
        close();
      },
    });
  }
}
