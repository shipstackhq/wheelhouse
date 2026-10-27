// Pure text helpers of the agent briefing: no database, so they are tested on their own.

export const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.replace(/^[-*]\s*/, "").trim() ?? "";
export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Join sections in priority order until the character budget is spent. */
export function budgeted(sections: (string | null)[], max: number) {
  const out: string[] = [];
  let used = 0;
  for (const s of sections) {
    if (!s) continue;
    if (used + s.length > max) {
      const room = max - used;
      if (room > 200) out.push(clip(s, room) + "\n");
      out.push(`_(briefing trimmed to ${max} chars; drill in with get_map)_`);
      break;
    }
    out.push(s);
    used += s.length;
  }
  return out.join("\n");
}
