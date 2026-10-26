import { Inject, Injectable } from "@nestjs/common";
import { randomToken, sha256 } from "../../common/crypto";
import { rateLimit } from "../../common/rate-limit";
import { ServiceError } from "../../common/service-error";
import { isUuid } from "../../common/uuid";
import { assertionSubject, publicKeyFromRaw, rawPublicKey, verifyAssertion } from "./daemon-crypto";
import { DeviceAuthError } from "./daemon-errors";
import { DaemonRepository } from "./daemon.repository";
import { PAIRING_STARTS_PER_IP, userCode } from "./daemon.rules";
import { type Device, PAIRING_POLL_INTERVAL_S, PAIRING_TTL_MS, TOKEN_TTL_S, str } from "./device-common";
import { DeviceStreamService } from "./device-stream.service";

export type PollResult =
  | { status: "pending" | "slow_down" | "denied" | "expired" }
  | { status: "approved"; deviceId: string; serverPublicKey: string; device: { name: string; poolSize: number } };

/**
 * How a machine gets in: pairing from its side (RFC 8628: it starts and polls, a person approves in DevicesService), the exchange of
 * a signed assertion for a short-lived token, and checking that token (the device guard). Needs no credentials until the token. Nothing
 * here calls another module: this is the daemon role's own code. See wheelhouse-cli/daemon/DESIGN.md.
 */
@Injectable()
export class DeviceAuthService {
  constructor(
    @Inject(DaemonRepository) private readonly repo: DaemonRepository,
    @Inject(DeviceStreamService) private readonly stream: DeviceStreamService,
  ) {}

  /**
   * Step 1, from the daemon: `{ publicKey, name, os }`. Answers the device code (the daemon's secret for polling), the code the person
   * types in Wheelhouse, and where to type it. Nothing is created until a signed-in person approves.
   */
  async startPairing(input: Record<string, unknown>, ctx: { ip: string; origin: string }) {
    const limited = rateLimit(`pair-start:${ctx.ip}`, PAIRING_STARTS_PER_IP, 60 * 60_000);
    if (!limited.ok) throw new ServiceError("forbidden", "Too many pairing attempts from this address; try again later");
    const key = publicKeyFromRaw(input.publicKey);
    if (!key) throw new ServiceError("invalid", "publicKey must be a raw Ed25519 public key in base64url", { fields: { publicKey: "Ed25519, base64url" } });
    const name = str(input.name, 80);
    const os = str(input.os, 40);
    if (!name) throw new ServiceError("invalid", "name is required", { fields: { name: "required" } });
    if (!os) throw new ServiceError("invalid", "os is required", { fields: { os: "required" } });
    await this.repo.deleteOldPairings(new Date(Date.now() - PAIRING_TTL_MS));
    const deviceCode = randomToken();
    const code = userCode();
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
    await this.repo.insertPairing({ deviceCodeHash: sha256(deviceCode), userCode: code, publicKey: rawPublicKey(key), name, os, expiresAt });
    const verificationUri = `${ctx.origin}/devices/pair`;
    return {
      deviceCode,
      userCode: code,
      verificationUri,
      verificationUriComplete: `${verificationUri}?code=${encodeURIComponent(code)}`,
      expiresIn: Math.round(PAIRING_TTL_MS / 1000),
      interval: PAIRING_POLL_INTERVAL_S,
    };
  }

  /**
   * Step 3, from the daemon: `{ deviceCode }`, every `interval` seconds until it is approved, denied or expired. The approved answer is
   * given once (the pairing is then consumed) and carries the server's public key, which the daemon pins.
   */
  async pollPairing(input: Record<string, unknown>, now = new Date()): Promise<PollResult> {
    const deviceCode = str(input.deviceCode, 200);
    if (!deviceCode) throw new ServiceError("invalid", "deviceCode is required");
    const p = await this.repo.pairingByDeviceCodeHash(sha256(deviceCode));
    if (!p || p.state === "consumed" || p.expiresAt < now) return { status: "expired" };
    if (p.state === "denied") return { status: "denied" };
    if (p.state === "pending") {
      const tooSoon = p.lastPolledAt && now.getTime() - p.lastPolledAt.getTime() < (PAIRING_POLL_INTERVAL_S - 1) * 1000;
      await this.repo.touchPairing(p.id, now);
      return { status: tooSoon ? "slow_down" : "pending" };
    }
    // Approved: hand over once.
    const claimed = await this.repo.movePairing(p.id, "approved", "consumed");
    if (!claimed?.deviceId) return { status: "expired" };
    const device = await this.repo.deviceById(claimed.deviceId);
    if (!device) return { status: "expired" };
    const { publicKey } = await this.stream.signingKey();
    return {
      status: "approved",
      deviceId: device.id,
      serverPublicKey: rawPublicKey(publicKey),
      device: { name: device.name, poolSize: device.poolSize },
    };
  }

  /**
   * `{ assertion }`: an EdDSA JWT the device signed with its own key (`sub` its id, `aud` wheelhouse:daemon-token, a fresh `jti`, a few
   * minutes' life). Answers a 15-minute access token. Each assertion works once. Every failure reads the same.
   */
  async exchangeAssertion(input: Record<string, unknown>, ctx: { ip: string }) {
    const fail = () => {
      const r = rateLimit(`device-token-fail:${ctx.ip}`, 30, 60_000);
      if (!r.ok) throw new ServiceError("forbidden", "Too many failed attempts; try again later");
      return new DeviceAuthError("Invalid assertion");
    };
    const jwt = str(input.assertion, 4000);
    const sub = assertionSubject(jwt);
    if (!sub || !isUuid(sub)) throw fail();
    const device = await this.repo.deviceById(sub);
    const key = device ? publicKeyFromRaw(device.publicKey) : null;
    const claims = key ? verifyAssertion(jwt, key) : null;
    if (!device || !claims || device.revokedAt) throw fail();
    const token = `whd_${randomToken()}`;
    const expiresAt = new Date(Date.now() + TOKEN_TTL_S * 1000);
    await this.repo.deleteExpiredTokens(device.id, new Date());
    const inserted = await this.repo.insertToken({ tokenHash: sha256(token), deviceId: device.id, jti: claims.jti, expiresAt });
    if (!inserted.length) throw fail(); // the assertion was used before
    return { accessToken: token, tokenType: "Bearer", expiresIn: TOKEN_TTL_S };
  }

  /** The device behind `Authorization: Bearer whd_...`. Revoked devices and expired tokens are refused. */
  async deviceForToken(authorization: string | null | undefined, now = new Date()): Promise<Device> {
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!token.startsWith("whd_")) throw new DeviceAuthError("Missing device token");
    const device = await this.repo.deviceForTokenHash(sha256(token), now);
    if (!device || device.revokedAt) throw new DeviceAuthError("Invalid or expired device token");
    const used = rateLimit(`device:${device.id}`, 1200, 60_000);
    if (!used.ok) throw new ServiceError("forbidden", "Too many requests from this device");
    return device;
  }
}
