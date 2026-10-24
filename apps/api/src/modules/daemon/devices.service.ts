import { Inject, Injectable } from "@nestjs/common";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { isUuid } from "../../common/uuid";
import { Database } from "../../platform/database/database";
import { TeamAccessService } from "../teams/index";
import { DaemonRepository } from "./daemon.repository";
import { deviceView } from "./daemon.presenter";
import { normalizeUserCode } from "./daemon.rules";
import { ACTIVE, MAX_POOL_SIZE, str, type Device } from "./device-common";
import { DeviceStreamService } from "./device-stream.service";

/**
 * A person's machines: list, approve a pairing, rename, resize, unpair. The person's side, so it is part of the api role (it asks the
 * teams module for the person's workspace role). Devices are selected by owner id AND the caller's workspace id: another person's or
 * another workspace's device is not_found. See wheelhouse-cli/daemon/DESIGN.md.
 */
@Injectable()
export class DevicesService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(DaemonRepository) private readonly repo: DaemonRepository,
    @Inject(DeviceStreamService) private readonly stream: DeviceStreamService,
    @Inject(TeamAccessService) private readonly access: TeamAccessService,
  ) {}

  /** The person's own paired machines in this workspace, each with how many jobs it is running. */
  async listDevices(actor: Actor) {
    if (actor.kind !== "human") throw new ServiceError("forbidden", "Only a person has devices");
    const rows = await this.repo.listOwnDevices(actor.id, actor.workspaceId);
    const busy = rows.length ? await this.repo.activeJobCounts(rows.map((r) => r.id), ACTIVE) : [];
    const count = new Map(busy.map((b) => [b.deviceId, b.n]));
    return rows.map((d) => ({ ...deviceView(d), activeJobs: count.get(d.id) ?? 0 }));
  }

  async ownDevice(actor: Actor, id: string): Promise<Device> {
    if (actor.kind !== "human" || !isUuid(id)) throw new ServiceError("not_found", "Device not found");
    const d = await this.repo.ownDevice(actor.id, actor.workspaceId, id);
    if (!d) throw new ServiceError("not_found", "Device not found");
    return d;
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

  /** Only people who can work in the workspace pair machines: a viewer or guest cannot run agents. */
  private async requirePairer(actor: Actor) {
    if (actor.kind !== "human") throw new ServiceError("forbidden", "Only a person can pair a machine");
    const role = await this.access.workspaceRoleOf(actor.workspaceId, actor.id);
    if (!role || role === "viewer" || role === "guest") throw new ServiceError("forbidden", "Your workspace role cannot run agents on a machine");
  }

  /** What the approval page shows before the person says yes: the machine as it described itself. */
  async peekPairing(actor: Actor, code: unknown) {
    await this.requirePairer(actor);
    const p = await this.pendingPairing(code);
    return { userCode: p.userCode, name: p.name, os: p.os, expiresAt: p.expiresAt.toISOString() };
  }

  /** Step 2, the person: approve the machine into their workspace, optionally renaming it. The device row is created here. */
  async approvePairing(actor: Actor, code: unknown, input: { name?: unknown } = {}) {
    await this.requirePairer(actor);
    const p = await this.pendingPairing(code);
    const name = str(input.name, 80) || p.name;
    return this.db.transaction(async () => {
      const claimed = await this.repo.movePairing(p.id, "pending", "approved");
      if (!claimed) throw new ServiceError("conflict", "This code was just used");
      if (await this.repo.deviceByPublicKey(p.publicKey)) throw new ServiceError("conflict", "This machine's key is already paired; unpair it first");
      const d = await this.repo.insertDevice({ workspaceId: actor.workspaceId, ownerId: actor.id, name, os: p.os, publicKey: p.publicKey });
      await this.repo.setPairingDevice(p.id, d.id);
      return { device: deviceView(d) };
    });
  }

  async denyPairing(actor: Actor, code: unknown) {
    await this.requirePairer(actor);
    const p = await this.pendingPairing(code);
    await this.repo.movePairing(p.id, "pending", "denied");
    return { ok: true as const };
  }
}
