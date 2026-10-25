import crypto from "node:crypto";

/**
 * The cryptography between Wheelhouse and the agent daemon. Both ends use Ed25519: a device proves who it is by signing an assertion
 * with its own key, and the server signs every message it sends a device so the daemon runs nothing it cannot verify. Keys travel
 * as the raw 32-byte public key in base64url. Signatures are over the canonical JSON of a value (keys sorted, no spaces), which the
 * daemon computes the same way.
 */

/** JSON with object keys sorted at every level, so both ends sign and verify the same bytes. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonicalJson(x))).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

const RAW_KEY_RE = /^[A-Za-z0-9_-]{43}$/;

/** A device's public key as sent (raw 32 bytes, base64url), or null when it is not one. */
export function publicKeyFromRaw(raw: unknown): crypto.KeyObject | null {
  if (typeof raw !== "string" || !RAW_KEY_RE.test(raw)) return null;
  try {
    return crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw }, format: "jwk" });
  } catch {
    return null;
  }
}

export const rawPublicKey = (k: crypto.KeyObject) => k.export({ format: "jwk" }).x as string;

export const signValue = (key: crypto.KeyObject, value: unknown) => crypto.sign(null, Buffer.from(canonicalJson(value)), key).toString("base64url");

export function verifyValue(key: crypto.KeyObject, value: unknown, signature: string) {
  try {
    return crypto.verify(null, Buffer.from(canonicalJson(value)), key, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

// ───────── the device's assertion ─────────

/** What a device's assertion must name as its audience. */
export const ASSERTION_AUDIENCE = "wheelhouse:daemon-token";
/** An assertion is good for at most this long, and its clock may be this far off ours. */
export const ASSERTION_MAX_LIFETIME_S = 300;
export const CLOCK_SKEW_S = 60;

export type Assertion = { sub: string; jti: string; iat: number; exp: number };

/** The device id an assertion claims, read without checking it, so the right public key can be looked up. Null when it is not a JWT. */
export function assertionSubject(jwt: string): string | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof p?.sub === "string" ? p.sub : null;
  } catch {
    return null;
  }
}

/**
 * Checks an EdDSA JWT signed by the device: algorithm, signature, audience, and a short lifetime around now. Returns the claims, or
 * null for anything wrong (the caller answers every failure the same way).
 */
export function verifyAssertion(jwt: string, key: crypto.KeyObject, now = Date.now()): Assertion | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  let header: { alg?: unknown; typ?: unknown };
  let claims: { sub?: unknown; aud?: unknown; jti?: unknown; iat?: unknown; exp?: unknown };
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (header.alg !== "EdDSA") return null;
  let ok = false;
  try {
    ok = crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"));
  } catch {
    return null;
  }
  if (!ok) return null;
  const { sub, aud, jti, iat, exp } = claims;
  if (typeof sub !== "string" || aud !== ASSERTION_AUDIENCE || typeof jti !== "string" || jti.length < 16 || jti.length > 128) return null;
  if (typeof iat !== "number" || typeof exp !== "number" || exp <= iat || exp - iat > ASSERTION_MAX_LIFETIME_S) return null;
  const s = now / 1000;
  if (iat > s + CLOCK_SKEW_S || exp < s - CLOCK_SKEW_S) return null;
  return { sub, jti, iat, exp };
}
