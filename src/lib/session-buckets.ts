/**
 * How recently a client session was active, in the buckets the Bots menu and the
 * dashboard group sessions by. Pure so the server (which assigns it) and tests share one definition.
 */
export const BUCKETS = [
  { id: "h6", label: "Last 6 hours", maxMs: 6 * 3600e3 },
  { id: "h12", label: "6–12 hours ago", maxMs: 12 * 3600e3 },
  { id: "h24", label: "12–24 hours ago", maxMs: 24 * 3600e3 },
  { id: "d7", label: "1–7 days ago", maxMs: 7 * 864e5 },
] as const;

export type BucketId = (typeof BUCKETS)[number]["id"];

/** Sessions idle longer than this are deleted automatically. */
export const SESSION_IDLE_LIMIT_MS = BUCKETS[BUCKETS.length - 1].maxMs;
/** Manually removed sessions are kept this long so a reconnect can be recognised. */
export const REMOVED_KEEP_MS = 30 * 864e5;

/** The bucket for a session last active at `lastSeenAt`, or null when it is older than a week. A bucket includes its upper bound. */
export function bucketOf(lastSeenAt: Date | string | number, now: number = Date.now()): BucketId | null {
  const idle = Math.max(0, now - new Date(lastSeenAt).getTime());
  return BUCKETS.find((b) => idle <= b.maxMs)?.id ?? null;
}

/** Group sessions by bucket, newest bucket first, leaving out buckets with no sessions. */
export function groupByBucket<T extends { bucket: BucketId }>(sessions: T[]) {
  return BUCKETS.map((b) => ({ id: b.id, label: b.label, sessions: sessions.filter((s) => s.bucket === b.id) })).filter((g) => g.sessions.length > 0);
}
