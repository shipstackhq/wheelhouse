import crypto from "node:crypto";

/**
 * Check GitHub's `X-Hub-Signature-256` header ("sha256=<hex>") against the raw request body.
 * Anything malformed, missing or wrong is simply "no": the caller answers with one plain 401 and learns nothing.
 * The comparison is constant-time so the secret cannot be guessed a byte at a time.
 */
export function verifySignature(secret: string, rawBody: string | Buffer, header: string | null | undefined): boolean {
  if (!secret || !header) return false;
  const m = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim());
  if (!m) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(m[1], "hex");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** What GitHub would send for `body`, for tests and local checks. */
export const signBody = (secret: string, body: string | Buffer) => `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
