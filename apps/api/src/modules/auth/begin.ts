import type { Response } from "express";
import { AccountError } from "./accounts";
import { humanFromSession, startSession } from "./auth-core";
import { meView } from "./me";
import { setSessionCookie } from "../../common/http/session-cookie";

/** Start a session for a person who has just proved who they are (sign in, sign up, accepting an invite): set the cookie, answer with who they are. */
export async function beginSession(userId: string, res: Response) {
  const { token, expiresAt } = await startSession(userId);
  setSessionCookie(res, token, expiresAt);
  const human = await humanFromSession(token);
  if (!human) throw new AccountError("unauthorized", "Could not start a session");
  return meView(human, token);
}
