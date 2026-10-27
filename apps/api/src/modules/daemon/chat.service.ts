import crypto from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { isUuid } from "../../common/uuid";
import { randomToken, sha256 } from "../../common/crypto";
import { Database } from "../../platform/database/database";
import { DaemonRepository } from "./daemon.repository";
import { chatMessageView, chatThreadView, deviceOnline, deviceView } from "./daemon.presenter";
import { CHAT_KEY_TTL_MS, CHAT_MESSAGE_MAX, OFFER_TTL_MS, str } from "./device-common";
import { DeviceStreamService } from "./device-stream.service";
import { DevicesService } from "./devices.service";
import { RunsService } from "./runs.service";

const isUnique = (e: unknown) => {
  const code = (e as { code?: string; cause?: { code?: string } } | null);
  return code?.code === "23505" || code?.cause?.code === "23505";
};

/**
 * Chat with the codebase, the person's side (docs/chat.md): their threads, asking, stopping and deleting. A thread is the owner's alone
 * (selected by thread id AND owner id AND workspace id, so anyone else's is not_found) and runs only on a device they own. The team's
 * repositories come through the github module (via RunsService), the way a run's do.
 */
@Injectable()
export class ChatService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(DaemonRepository) private readonly repo: DaemonRepository,
    @Inject(DeviceStreamService) private readonly stream: DeviceStreamService,
    @Inject(DevicesService) private readonly devices: DevicesService,
    @Inject(RunsService) private readonly runs: RunsService,
  ) {}

  private human(actor: Actor) {
    if (actor.kind !== "human") throw new ServiceError("forbidden", "Only a person can chat with their machine");
    return actor;
  }

  private async own(actor: Actor, id: string) {
    this.human(actor);
    const row = isUuid(id) ? await this.repo.ownThread(id, actor.id, actor.workspaceId) : undefined;
    if (!row) throw new ServiceError("not_found", "Chat not found");
    return row;
  }

  private async view(actor: Actor, id: string) {
    const row = await this.own(actor, id);
    return { chat: chatThreadView(row), messages: (await this.repo.threadMessages(id)).map(chatMessageView) };
  }

  private body(message: unknown) {
    const text = typeof message === "string" ? message.trim() : "";
    if (!text || text.length > CHAT_MESSAGE_MAX) throw new ServiceError("invalid", `A message is 1 to ${CHAT_MESSAGE_MAX} characters`, { fields: { message: `1 to ${CHAT_MESSAGE_MAX} characters` } });
    return text;
  }

  /** The person's own devices and the team's runnable repositories a chat can use. */
  async options(actor: Actor, teamKey: string) {
    this.human(actor);
    const { runnable } = await this.runs.runnableRepositories(actor, teamKey);
    const mine = await this.devices.listDevices(actor);
    return {
      devices: mine.map((d) => ({ id: d.id, name: d.name, status: d.status, models: d.models })),
      repositories: runnable.map((r) => ({ id: r.id, name: r.displayName, fullName: r.githubFullName, defaultBranch: r.defaultBranch })),
    };
  }

  async list(actor: Actor) {
    this.human(actor);
    return { chats: (await this.repo.ownThreads(actor.id, actor.workspaceId)).map(chatThreadView) };
  }

  get(actor: Actor, id: string) {
    return this.view(actor, id);
  }

  /** Inserts the question and an empty answer, and writes the signed `chat.message` to the device, in one transaction. */
  private async ask(actor: Actor, thread: { id: string; teamId: string; workspaceId: string; deviceId: string; model: string; sessionId: string | null; title: string }, repo: { id: string; displayName: string; githubFullName: string | null; defaultBranch: string }, text: string) {
    const key = await this.stream.signingKey();
    const answerId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + OFFER_TTL_MS).toISOString();
    try {
      const rows = await this.db.transaction(async () => {
        const seq = await this.repo.lastMessageSeq(thread.id);
        const scope = { threadId: thread.id, teamId: thread.teamId, workspaceId: thread.workspaceId };
        const pair = await this.repo.insertMessages([
          { ...scope, seq: seq + 1, role: "user", content: text, state: "done" },
          { ...scope, id: answerId, seq: seq + 2, role: "assistant", state: "pending" },
        ]);
        await this.repo.touchThread(thread.id, { model: thread.model, updatedAt: new Date() });
        // The answer's own read-only key for the thread's team; the daemon reaches /mcp with it, and it is deleted when the answer ends.
        const token = `wh_${randomToken(24)}`;
        await this.repo.insertChatKey({ workspaceId: thread.workspaceId, teamId: thread.teamId, messageId: answerId, name: `Chat: ${thread.title}`.slice(0, 100), keyHash: sha256(token), expiresAt: new Date(Date.now() + CHAT_KEY_TTL_MS) });
        await this.stream.send(key, thread.deviceId, "chat.message", {
          messageId: answerId,
          threadId: thread.id,
          workspaceId: thread.workspaceId,
          model: thread.model,
          sessionId: thread.sessionId,
          prompt: text,
          repository: { id: repo.id, name: repo.displayName, fullName: repo.githubFullName, cloneUrl: `https://github.com/${repo.githubFullName}.git`, defaultBranch: repo.defaultBranch },
          expiresAt,
          mcp: { token },
        });
        return pair;
      });
      this.stream.wake(thread.deviceId);
      return rows;
    } catch (e) {
      if (isUnique(e)) throw new ServiceError("conflict", "An answer is still being written. Wait for it, or stop it.");
      throw e;
    }
  }

  /** `{ teamKey, repositoryId, deviceId, model, message }`: a new thread with its first question. */
  async create(actor: Actor, input: Record<string, unknown>) {
    this.human(actor);
    const teamKey = str(input.teamKey, 60);
    if (!teamKey) throw new ServiceError("invalid", "Pick a team", { fields: { teamKey: "required" } });
    const text = this.body(input.message);
    const device = await this.devices.ownDevice(actor, str(input.deviceId, 60)).catch(() => {
      throw new ServiceError("invalid", "Pick one of your devices", { fields: { deviceId: "one of your paired devices" } });
    });
    if (!deviceOnline(device)) throw new ServiceError("conflict", `${device.name} is offline. Start the daemon on it and try again.`);
    const { runnable } = await this.runs.runnableRepositories(actor, teamKey);
    const repo = runnable.find((r) => r.id === str(input.repositoryId, 60));
    if (!repo) throw new ServiceError("invalid", "Pick one of the team's GitHub repositories", { fields: { repositoryId: "one of the team's GitHub repositories" } });
    const models = deviceView(device).models;
    const model = str(input.model, 60);
    if (!model || !models.includes(model)) throw new ServiceError("invalid", `Pick a model ${device.name} offers: ${models.join(", ")}`, { fields: { model: models.join(", ") } });
    const id = crypto.randomUUID();
    // The thread and its first pair share one transaction through `ask`'s own; the thread is removed again if the pair cannot be written.
    const thread = await this.repo.insertThread({ id, teamId: repo.teamId, workspaceId: actor.workspaceId, ownerId: actor.id, deviceId: device.id, repositoryId: repo.id, model, title: text.replace(/\s+/g, " ").slice(0, 80) });
    try {
      await this.ask(actor, thread, repo, text);
    } catch (e) {
      await this.repo.deleteThread(id);
      throw e;
    }
    this.stream.signalChat(thread);
    return this.view(actor, id);
  }

  /**
   * `{ message, model? }`: the next question, resuming the thread's Claude session. `model` switches the thread to another model its device
   * offers, from this question on (the session carries over). 409 while an answer is still running.
   */
  async send(actor: Actor, id: string, input: Record<string, unknown>) {
    const row = await this.own(actor, id);
    const text = this.body(input.message);
    if (row.running) throw new ServiceError("conflict", "An answer is still being written. Wait for it, or stop it.");
    const device = await this.devices.ownDevice(actor, row.thread.deviceId).catch(() => {
      throw new ServiceError("conflict", "The device this chat runs on was unpaired");
    });
    if (!deviceOnline(device)) throw new ServiceError("conflict", `${device.name} is offline. Start the daemon on it and try again.`);
    const models = deviceView(device).models;
    const model = input.model === undefined || input.model === null || input.model === "" ? row.thread.model : str(input.model, 60);
    if (model !== row.thread.model && !models.includes(model)) throw new ServiceError("invalid", `Pick a model ${device.name} offers: ${models.join(", ")}`, { fields: { model: models.join(", ") } });
    const repo = row.thread.repositoryId ? (await this.runs.runnableRepositories(actor, row.teamKey)).runnable.find((r) => r.id === row.thread.repositoryId) : undefined;
    if (!repo) throw new ServiceError("conflict", "The repository of this chat is no longer available");
    const pair = await this.ask(actor, { ...row.thread, model }, repo, text);
    this.stream.signalChat(row.thread);
    return { messages: pair.map(chatMessageView) };
  }

  /**
   * Stop the running answer: the device is sent a signed cancel and the answer ends `canceled` when it reports. If the device is gone
   * (offline or unpaired) nothing would ever report, so it ends at once.
   */
  async cancel(actor: Actor, id: string) {
    const row = await this.own(actor, id);
    await this.stopRunning(row);
    const fresh = await this.own(actor, id);
    return { chat: chatThreadView(fresh) };
  }

  private async stopRunning(row: { thread: { id: string; teamId: string; workspaceId: string; ownerId: string; deviceId: string }; deviceLastSeenAt: Date | null; deviceRevokedAt: Date | null }) {
    const answer = await this.repo.runningAnswer(row.thread.id);
    if (!answer) return;
    if (!deviceOnline({ lastSeenAt: row.deviceLastSeenAt, revokedAt: row.deviceRevokedAt })) {
      const ended = await this.repo.moveMessage(answer.id, ["pending", "streaming"], { state: "canceled", error: null });
      if (ended) this.stream.signalChat(row.thread);
      return;
    }
    const key = await this.stream.signingKey();
    await this.db.transaction(() => this.stream.send(key, row.thread.deviceId, "chat.cancel", { messageId: answer.id }));
    this.stream.wake(row.thread.deviceId);
  }

  /** Deletes the thread and its messages, stopping a running answer first. */
  async remove(actor: Actor, id: string) {
    const row = await this.own(actor, id);
    await this.stopRunning(row);
    await this.repo.deleteThread(row.thread.id);
    this.stream.signalChat(row.thread);
  }
}
