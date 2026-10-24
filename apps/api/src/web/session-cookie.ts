import type { Response } from "express";
import { SESSION_COOKIE } from "../modules/auth/auth-core";

/** The session cookie, set exactly as the Next app sets it: httpOnly, SameSite=Lax, Secure in production, path /, 30 days. */
export function setSessionCookie(res: Response, token: string, expires: Date) {
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", expires });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}
