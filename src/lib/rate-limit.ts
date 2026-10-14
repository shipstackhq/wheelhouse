/**
 * In-memory fixed-window rate limiter. State lives in this process, which is correct for the
 * single-instance deployment (one app container, see docker-compose.yml); it resets on restart.
 */
type Bucket = { count: number; resetAt: number };

const g = globalThis as unknown as { __whRateLimits?: Map<string, Bucket> };
const buckets = (g.__whRateLimits ??= new Map<string, Bucket>());
const SWEEP_AT = 10_000;

export type RateResult = { ok: boolean; retryAfter: number };

/** Counts one hit against `key`; `ok` is false once more than `limit` hits land inside `windowMs`. */
export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): RateResult {
  if (buckets.size > SWEEP_AT) for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count++;
  return { ok: b.count <= limit, retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
}

/** Forget a key, e.g. after a successful login. */
export function resetRateLimit(key: string) {
  buckets.delete(key);
}

/**
 * Client address behind the reverse proxy. Uses the LAST x-forwarded-for entry: that is the one the
 * nearest proxy (Caddy) appended, so a client cannot choose it by sending its own header.
 */
export function clientIp(h: Headers): string {
  const xff = h.get("x-forwarded-for");
  if (xff) {
    const last = xff.split(",").pop()?.trim();
    if (last) return last;
  }
  return h.get("x-real-ip")?.trim() || "unknown";
}

export const minutes = (n: number) => Math.ceil(n / 60);
