import { ServiceError } from "./service-error";

/** Labels as stored: trimmed, no empties or repeats (case-insensitively, first spelling wins), at most 20 of at most 40 characters. */
export function cleanLabels(input: string[], what = "issue"): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const l = raw.trim().replace(/\s+/g, " ");
    if (!l || seen.has(l.toLowerCase())) continue;
    if (l.length > 40) throw new ServiceError("invalid", `A label is at most 40 characters ("${l.slice(0, 20)}…")`);
    seen.add(l.toLowerCase());
    out.push(l);
  }
  if (out.length > 20) throw new ServiceError("invalid", `A ${what} has at most 20 labels`);
  return out;
}
