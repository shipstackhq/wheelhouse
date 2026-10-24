import { and, eq, gt, lt } from "drizzle-orm";
import { getDb, schema } from "../../db";
import { sha256 } from "../../common/crypto";
import { randomToken } from "../../common/crypto";
import { assertionSubject, publicKeyFromRaw, verifyAssertion } from "./daemon-crypto";
import { rateLimit } from "../../common/rate-limit";
import { ServiceError } from "../../lib/service";
import { isUuid } from "../../common/uuid";
import { type Device, TOKEN_TTL_S, str } from "./device-common";

/** A paired machine's short-lived tokens: the signed assertion exchange and checking a bearer token. See wheelhouse-cli/daemon/DESIGN.md. */
const { devices, deviceTokens } = schema;

export class DeviceAuthError extends Error {
  status = 401;
}

/**
 * `{ assertion }`: an EdDSA JWT the device signed with its own key (`sub` its id, `aud` wheelhouse:daemon-token, a fresh `jti`, a few
 * minutes' life). Answers a 15-minute access token. Each assertion works once. Every failure reads the same.
 */
export async function exchangeAssertion(input: Record<string, unknown>, ctx: { ip: string }) {
  const fail = () => {
    const r = rateLimit(`device-token-fail:${ctx.ip}`, 30, 60_000);
    if (!r.ok) throw new ServiceError("forbidden", "Too many failed attempts; try again later");
    return new DeviceAuthError("Invalid assertion");
  };
  const jwt = str(input.assertion, 4000);
  const sub = assertionSubject(jwt);
  if (!sub || !isUuid(sub)) throw fail();
  const db = await getDb();
  const [row] = await db
    .select({ device: devices, suspendedAt: schema.workspaces.suspendedAt })
    .from(devices)
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, devices.workspaceId))
    .where(eq(devices.id, sub));
  const key = row ? publicKeyFromRaw(row.device.publicKey) : null;
  const claims = key ? verifyAssertion(jwt, key) : null;
  if (!row || !claims || row.device.revokedAt) throw fail();
  if (row.suspendedAt) throw new ServiceError("forbidden", "This workspace has been suspended");
  const token = `whd_${randomToken()}`;
  const expiresAt = new Date(Date.now() + TOKEN_TTL_S * 1000);
  await db.delete(deviceTokens).where(and(eq(deviceTokens.deviceId, row.device.id), lt(deviceTokens.expiresAt, new Date())));
  const inserted = await db.insert(deviceTokens).values({ tokenHash: sha256(token), deviceId: row.device.id, jti: claims.jti, expiresAt }).onConflictDoNothing().returning();
  if (!inserted.length) throw fail(); // the assertion was used before
  return { accessToken: token, tokenType: "Bearer", expiresIn: TOKEN_TTL_S };
}

/** The device behind `Authorization: Bearer whd_...`. Revoked devices, expired tokens and suspended workspaces are refused. */
export async function deviceForToken(authorization: string | null | undefined, now = new Date()): Promise<Device> {
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token.startsWith("whd_")) throw new DeviceAuthError("Missing device token");
  const db = await getDb();
  const [row] = await db
    .select({ device: devices, suspendedAt: schema.workspaces.suspendedAt })
    .from(deviceTokens)
    .innerJoin(devices, eq(devices.id, deviceTokens.deviceId))
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, devices.workspaceId))
    .where(and(eq(deviceTokens.tokenHash, sha256(token)), gt(deviceTokens.expiresAt, now)));
  if (!row || row.device.revokedAt) throw new DeviceAuthError("Invalid or expired device token");
  if (row.suspendedAt) throw new ServiceError("forbidden", "This workspace has been suspended");
  const used = rateLimit(`device:${row.device.id}`, 1200, 60_000);
  if (!used.ok) throw new ServiceError("forbidden", "Too many requests from this device");
  return row.device;
}
