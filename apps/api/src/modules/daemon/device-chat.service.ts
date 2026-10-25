import { Inject, Injectable } from "@nestjs/common";
import type { ChatMessageState } from "../../db/schema";
import { ServiceError } from "../../common/service-error";
import { isUuid } from "../../common/uuid";
import { DaemonRepository, type ChatMessageRow, type ChatMessagePatch } from "./daemon.repository";
import { CHAT_ACTIVITY_MAX, CHAT_CONTENT_MAX, CHAT_PENDING_MS, CHAT_QUIET_MS, MAX_EVENTS_PER_BATCH, type Device, str } from "./device-common";
import { DeviceStreamService } from "./device-stream.service";

const OPEN: ChatMessageState[] = ["pending", "streaming"];
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * A chat answer from the machine's side (docs/chat.md): the events the device streams while it answers, how it ends, and the sweep for
 * answers that never started or went quiet. Every method takes the device the token names and reaches a message by message id AND that
 * device's id, so another device's message is not_found.
 */
@Injectable()
export class DeviceChatService {
  constructor(
    @Inject(DaemonRepository) private readonly repo: DaemonRepository,
    @Inject(DeviceStreamService) private readonly stream: DeviceStreamService,
  ) {}

  private async deviceMessage(device: Device, messageId: string) {
    if (!isUuid(messageId)) throw new ServiceError("not_found", "No such message");
    const row = await this.repo.messageOfDevice(messageId, device.id);
    if (!row || row.message.role !== "assistant") throw new ServiceError("not_found", "No such message");
    return row;
  }

  /**
   * `{ events: [{ seq, at, type, data }] }`. An event counts only if its `seq` is above the message's `lastEventSeq`, so a batch sent
   * again is harmless. `delta` text is appended to the answer, `tool` calls to its activity (the latest 30); `phase` is ignored. The
   * first accepted event moves a pending answer to streaming.
   */
  async recordChatEvents(device: Device, messageId: string, input: Record<string, unknown>) {
    const { message, thread } = await this.deviceMessage(device, messageId);
    if (!OPEN.includes(message.state)) throw new ServiceError("conflict", `The message is ${message.state}`);
    const list = (Array.isArray(input.events) ? input.events.slice(0, MAX_EVENTS_PER_BATCH) : [])
      .map((e) => (e && typeof e === "object" ? (e as Record<string, unknown>) : {}))
      .filter((e) => Number.isInteger(e.seq) && (e.seq as number) >= 0 && str(e.type, 60))
      .sort((a, b) => (a.seq as number) - (b.seq as number));
    let last = message.lastEventSeq;
    let text = "";
    let activity = message.activity;
    let stored = 0;
    let deltas = 0;
    for (const e of list) {
      if ((e.seq as number) <= last) continue;
      last = e.seq as number;
      stored++;
      const data = e.data && typeof e.data === "object" && !Array.isArray(e.data) ? (e.data as Record<string, unknown>) : {};
      if (e.type === "delta" && typeof data.text === "string") {
        text += data.text;
        deltas++;
      } else if (e.type === "tool") activity = [...activity, { name: str(data.name, 80), summary: str(data.summary, 300) }].slice(-CHAT_ACTIVITY_MAX);
    }
    if (!stored) return { stored: 0 };
    const patch: ChatMessagePatch = { lastEventSeq: last, state: "streaming", activity };
    if (text) patch.content = (message.content + text).slice(0, CHAT_CONTENT_MAX);
    // Guarded by the event number it was read at, so two batches racing cannot both apply; the loser is sent again by the daemon.
    const row = await this.repo.moveMessage(message.id, OPEN, patch, message.lastEventSeq);
    if (!row) return { stored: 0 };
    // Only a batch of text alone is throttled; the first event (pending to streaming) and tool calls tell the person at once.
    this.stream.signalChat(thread, message.state === "streaming" && deltas === stored ? 300 : 0);
    return { stored };
  }

  /**
   * `{ state: done | failed | canceled, sessionId?, text?, costUsd?, error? }`: the answer is over. `text` fills an answer that streamed
   * nothing; `sessionId` is kept on the thread to resume. An answer that is already final is a 409, so the daemon stops retrying.
   */
  async finishChat(device: Device, messageId: string, input: Record<string, unknown>) {
    const { message, thread } = await this.deviceMessage(device, messageId);
    const state = input.state as ChatMessageState;
    if (!["done", "failed", "canceled"].includes(state)) throw new ServiceError("invalid", "state must be done, failed or canceled");
    if (!OPEN.includes(message.state)) throw new ServiceError("conflict", `The message is ${message.state}`);
    const text = typeof input.text === "string" ? input.text.slice(0, CHAT_CONTENT_MAX) : "";
    const cost = num(input.costUsd);
    const patch: ChatMessagePatch = { state, error: state === "done" ? null : str(input.error, 2000) || null };
    if (!message.content && text) patch.content = text;
    if (cost !== null) patch.costUsd = cost.toFixed(6);
    const row: ChatMessageRow | undefined = await this.repo.moveMessage(message.id, OPEN, patch);
    if (!row) throw new ServiceError("conflict", "The message is already final");
    const sessionId = str(input.sessionId, 200);
    await this.repo.touchThread(thread.id, { ...(sessionId ? { sessionId } : {}), updatedAt: new Date() });
    this.stream.signalChat(thread);
    return { ok: true as const };
  }

  /** Answers the device never started (60 s) or that went quiet (3 minutes) fail, and their owners are told. Returns how many. */
  async sweep(now = new Date()) {
    const failed = await this.repo.failStaleAnswers(new Date(now.getTime() - CHAT_PENDING_MS), new Date(now.getTime() - CHAT_QUIET_MS), now);
    for (const m of failed) {
      const thread = await this.repo.threadById(m.threadId);
      if (thread) this.stream.signalChat(thread);
    }
    return { failed: failed.length };
  }
}
