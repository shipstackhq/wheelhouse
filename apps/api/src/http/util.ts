import type { IncomingHttpHeaders } from "node:http";

/** The value of one cookie from a Cookie header, percent-decoded like Next's cookies() does. */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0 || part.slice(0, i).trim() !== name) continue;
    const v = part.slice(i + 1).trim();
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  return undefined;
}

/** Node's header bag as the web Headers that lib/rate-limit's clientIp() reads (repeated headers are joined with a comma). */
export function toHeaders(h: IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [k, v] of Object.entries(h)) {
    if (Array.isArray(v)) out.set(k, v.join(", "));
    else if (v !== undefined) out.set(k, v);
  }
  return out;
}
