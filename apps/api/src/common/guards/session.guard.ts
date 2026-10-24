import { Inject, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { AuthError } from "../../modules/auth/access";
import { humanFromSession, SESSION_COOKIE, type Human } from "../../modules/auth/auth-core";
import { IS_PUBLIC } from "../decorators/public.decorator";
import { cookieValue } from "../http/cookies";

export type SessionRequest = Request & { human: Human };

/**
 * A signed-in person (session cookie). Signed out is a JSON 401, never a redirect. The workspace comes from the session, never from
 * the request. Part of @AppEndpoints(), so it is on every /api/app route except those marked @Public().
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext) {
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [context.getHandler(), context.getClass()])) return true;
    const req = context.switchToHttp().getRequest<SessionRequest>();
    const human = await humanFromSession(cookieValue(req.headers.cookie, SESSION_COOKIE));
    if (!human) throw new AuthError("Not authenticated");
    req.human = human;
    return true;
  }
}
