import type { Request } from "express";

/**
 * The address people use to reach this server, for links we hand out (invites) and commands we print (the Agents page).
 * APP_URL when it is set; otherwise what the proxy says it forwarded, else the Host header.
 */
export function requestOrigin(req: Request): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, "");
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(",")[0].trim();
  const proto = first(req.headers["x-forwarded-proto"]) ?? "http";
  return `${proto}://${first(req.headers["x-forwarded-host"]) ?? req.headers.host ?? "localhost"}`;
}
