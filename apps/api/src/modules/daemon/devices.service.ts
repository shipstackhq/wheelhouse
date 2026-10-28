import { Inject, Injectable } from "@nestjs/common";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { isUuid } from "../../common/uuid";
import { Database } from "../../platform/database/database";
import { DaemonRepository } from "./daemon.repository";
import { deviceView } from "./daemon.presenter";
import { normalizeUserCode } from "./daemon.rules";
import { ACTIVE, MAX_POOL_SIZE, str, type Device } from "./device-common";
import { DeviceStreamService } from "./device-stream.service";

/**
 * A person's machines: list, approve a pairing, rename, resize, unpair. The person's side, so it is part of the api role. A device belongs to the person and serves every workspace they are in; devices are
 * selected by owner id: another person's device is not_found. See wheelhouse-cli/daemon/DESIGN.md.
 */
const EFFORTS = ["low", "medium", "high"] as const;

@Injectable()
export class DevicesService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(DaemonRepository) private readonly repo: DaemonRepository,
    @Inject(DeviceStreamService) private readonly stream: DeviceStreamService,
  ) {}

  /** The person's own paired machines, each with how many jobs it is running. */
  async listDevices(actor: Actor) {
    if (actor.kind !== "human") throw new ServiceError("forbidden", "Only a person has devices");
    const rows = await this.repo.listOwnDevices(actor.id);
    const busy = rows.length ? await this.repo.activeJobCounts(rows.map((r) => r.id), ACTIVE) : [];
    const count = new Map(busy.map((b) => [b.deviceId, b.n]));
    return rows.map((d) => ({ ...deviceView(d), activeJobs: count.get(d.id) ?? 0 }));
  }

  async ownDevice(actor: Actor, id: string): Promise<Device> {
    if (actor.kind !== "human" || !isUuid(id)) throw new ServiceError("not_found", "Device not found");
    const d = await this.repo.ownDevice(actor.id, id);
    if (!d) throw new ServiceError("not_found", "Device not found");
    return d;
  }

  /** WH-123: the person's own defaults for runs started in their name (null: no preference). */
  async getRunDefaults(actor: Actor) {
    if (actor.kind !== "human") throw new ServiceError("forbidden", "Only a person has run defaults");
    const r = await this.repo.runDefaults(actor.id);
    return { deviceId: r?.deviceId ?? null, model: r?.model ?? null, effort: r?.effort ?? null };
  }

  /** `{ deviceId?, model?, effort? }`: only what is named changes; null clears it. The device must be one of the person's own. */
  async setRunDefaults(actor: Actor, input: Record<string, unknown>) {
    const next = await this.getRunDefaults(actor);
    if (input.deviceId !== undefined) next.deviceId = input.deviceId === null ? null : (await this.ownDevice(actor, str(input.deviceId, 60))).id;
    if (input.model !== undefined) next.model = input.model === null ? null : str(input.model, 60) || null;
    if (input.effort !== undefined) {
      if (input.effort !== null && !EFFORTS.includes(input.effort as never)) throw new ServiceError("invalid", `effort must be ${EFFORTS.join(", ")}, or null`, { fields: { effort: EFFORTS.join(", ") } });
      next.effort = input.effort as typeof next.effort;
    }
    await this.repo.saveRunDefaults(actor.id, next);
    return next;
  }

  /** `{ name?, poolSize?, chatModel? }`. A new pool size or chat model is sent to the daemon as a signed settings message. */
  async updateDevice(actor: Actor, id: string, input: Record<string, unknown>) {
    const d = await this.ownDevice(actor, id);
    const patch: Parameters<DaemonRepository["updateDevice"]>[1] = {};
    if (input.name !== undefined) {
      const name = str(input.name, 80);
      if (!name) throw new ServiceError("invalid", "A device needs a name", { fields: { name: "required" } });
      patch.name = name;
    }
    if (input.poolSize !== undefined) {
      if (!Number.isInteger(input.poolSize) || (input.poolSize as number) < 1 || (input.poolSize as number) > MAX_POOL_SIZE)
        throw new ServiceError("invalid", `poolSize must be 1 to ${MAX_POOL_SIZE}`, { fields: { poolSize: `1 to ${MAX_POOL_SIZE}` } });
      patch.poolSize = input.poolSize as number;
    }
    if (input.chatModel !== undefined) patch.chatModel = input.chatModel === null ? null : str(input.chatModel, 60) || null;
    if (!Object.keys(patch).length) return { device: deviceView(d) };
    const key = await this.stream.signingKey();
    const updated = await this.db.transaction(async () => {
      const row = await this.repo.updateDevice(d.id, patch);
      if (patch.poolSize !== undefined || patch.chatModel !== undefined) await this.stream.send(key, d.id, "settings.update", { poolSize: row.poolSize, chatModel: row.chatModel });
      return row;
    });
    this.stream.wake(d.id);
    return { device: deviceView(updated) };
  }

  /**
   * Unpair: the device can no longer get a token, its open stream ends within seconds, and what it was doing is canceled (the daemon
   * stops them when it learns it was unpaired; whatever it pushed stays on its branch).
   */
  async revokeDevice(actor: Actor, id: string) {
    const d = await this.ownDevice(actor, id);
    const now = new Date();
    const ended = await this.db.transaction(async () => {
      await this.repo.revokeDevice(d.id, now);
      await this.repo.deleteTokens(d.id);
      return this.repo.cancelActiveJobsOfDevice(d.id, ACTIVE, now, "The device was unpaired");
    });
    for (const j of ended) this.stream.signalJob(j);
    this.stream.wake(d.id);
    return { ok: true as const, canceled: ended.length };
  }

  // ───────── pairing, the person's step ─────────

  private async pendingPairing(code: unknown) {
    const c = normalizeUserCode(code);
    if (!c) throw new ServiceError("not_found", "That code is not valid. Check it on the machine and try again.");
    const p = await this.repo.pairingByUserCode(c);
    if (!p || p.state !== "pending" || p.expiresAt < new Date()) throw new ServiceError("not_found", "That code is not valid or has expired. Start pairing again on the machine.");
    return p;
  }

  private requireHuman(actor: Actor) {
    if (actor.kind !== "human") throw new ServiceError("forbidden", "Only a person can pair a machine");
  }

  /** What the approval page shows before the person says yes: the machine as it described itself. */
  async peekPairing(actor: Actor, code: unknown) {
    await this.requireHuman(actor);
    const p = await this.pendingPairing(code);
    return { userCode: p.userCode, name: p.name, os: p.os, expiresAt: p.expiresAt.toISOString() };
  }

  /** Step 2, the person: approve the machine as theirs, optionally renaming it. The device row is created here. */
  async approvePairing(actor: Actor, code: unknown, input: { name?: unknown } = {}) {
    await this.requireHuman(actor);
    const p = await this.pendingPairing(code);
    const name = str(input.name, 80) || p.name;
    return this.db.transaction(async () => {
      const claimed = await this.repo.movePairing(p.id, "pending", "approved");
      if (!claimed) throw new ServiceError("conflict", "This code was just used");
      if (await this.repo.deviceByPublicKey(p.publicKey)) throw new ServiceError("conflict", "This machine's key is already paired; unpair it first");
      const d = await this.repo.insertDevice({ ownerId: actor.id, name, os: p.os, publicKey: p.publicKey });
      await this.repo.setPairingDevice(p.id, d.id);
      return { device: deviceView(d) };
    });
  }

  async denyPairing(actor: Actor, code: unknown) {
    await this.requireHuman(actor);
    const p = await this.pendingPairing(code);
    await this.repo.movePairing(p.id, "pending", "denied");
    return { ok: true as const };
  }
}
