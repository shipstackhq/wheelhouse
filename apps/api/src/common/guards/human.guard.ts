import { Catch, Injectable, type CanActivate, type ExceptionFilter, type ExecutionContext, type ArgumentsHost } from "@nestjs/common";
import type { Request, Response } from "express";
import { SESSION_COOKIE } from "../../modules/auth/auth-policy";
import { humanFromSession, type Human } from "../../modules/auth/index";
import { cookieValue } from "../http/cookies";

export type HumanRequest = Request & { human: Human };

/** Thrown when a page-like route needs a signed-in person and there is none. */
export class SignedOutException extends Error {}

/** Signed out means "go and sign in": a 307 to /login, as the Next app does. */
@Catch(SignedOutException)
export class SignedOutFilter implements ExceptionFilter {
  catch(_e: SignedOutException, host: ArgumentsHost) {
    host.switchToHttp().getResponse<Response>().redirect(307, "/login");
  }
}

/** A person with a session cookie (not an API key): their user, workspace and membership. For routes a browser visits. */
@Injectable()
export class HumanGuard implements CanActivate {
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<HumanRequest>();
    const human = await humanFromSession(cookieValue(req.headers.cookie, SESSION_COOKIE));
    if (!human) throw new SignedOutException();
    req.human = human;
    return true;
  }
}
