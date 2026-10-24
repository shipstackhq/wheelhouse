import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { AuthError } from "../../modules/auth/access";
import { humanFromSession, SESSION_COOKIE, type Human } from "../../modules/auth/auth-core";
import { cookieValue } from "../http/cookies";

export type SessionRequest = Request & { human: Human };

/** A signed-in person (session cookie). Signed out is a JSON 401, never a redirect. The workspace comes from the session, never from the request. */
@Injectable()
export class SessionGuard implements CanActivate {
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<SessionRequest>();
    const human = await humanFromSession(cookieValue(req.headers.cookie, SESSION_COOKIE));
    if (!human) throw new AuthError("Not authenticated");
    req.human = human;
    return true;
  }
}
