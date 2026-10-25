export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An id from a request that is not even shaped like one matches nothing: asking Postgres about it would be a 500, not a "not found". */
export function isUuid(v: string): boolean;
export function isUuid(v: unknown): v is string;
export function isUuid(v: unknown): boolean {
  return typeof v === "string" && UUID_RE.test(v);
}
