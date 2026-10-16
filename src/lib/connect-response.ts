import { NextResponse } from "next/server";
import type { ConnectReply } from "@wheelhouse/core/lib/github/connect";
import { STATE_COOKIE, STATE_COOKIE_PATH } from "@wheelhouse/core/lib/github/state";

/** Turn what @wheelhouse/core decided about connecting GitHub into a Next response, with the state cookie. */
export function connectResponse(r: ConnectReply, requestUrl: URL) {
  const res = r.redirect ? NextResponse.redirect(new URL(r.redirect, requestUrl), r.status as 307) : new NextResponse(r.text, { status: r.status });
  if (r.setStateCookie) res.cookies.set(STATE_COOKIE, r.setStateCookie.value, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: STATE_COOKIE_PATH, maxAge: r.setStateCookie.maxAgeSec });
  if (r.clearStateCookie) res.cookies.delete({ name: STATE_COOKIE, path: STATE_COOKIE_PATH });
  return res;
}
