import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import type { Actor } from "@wheelhouse/core/lib/access";
import { actorFromCredentials, SESSION_COOKIE } from "@wheelhouse/core/lib/auth-core";
import { clientIp } from "@wheelhouse/core/lib/rate-limit";
import { cookieValue, toHeaders } from "../http/util";

export type AuthedRequest = Request & { actor: Actor };

/**
 * Who is calling: an `Authorization: Bearer wh_...` API key, or a `wh_session` cookie. All of the rules (key hashing, revoked
 * keys, suspended workspaces, rate limits) are @wheelhouse/core's; this only reads the request. Failures are thrown as
 * @wheelhouse/core's AuthError and shaped by the controller's exception filter.
 */
@Injectable()
export class ActorGuard implements CanActivate {
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    req.actor = await actorFromCredentials({
      authorization: req.headers.authorization ?? null,
      sessionToken: cookieValue(req.headers.cookie, SESSION_COOKIE),
      ip: clientIp(toHeaders(req.headers)),
    });
    return true;
  }
}
