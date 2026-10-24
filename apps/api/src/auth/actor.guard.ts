import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import type { Actor } from "../common/actor";
import { actorFromCredentials, SESSION_COOKIE } from "../modules/auth/auth-core";
import { clientIp } from "../lib/rate-limit";
import { cookieValue, toHeaders } from "../http/util";

export type AuthedRequest = Request & { actor: Actor };

/**
 * Who is calling: an `Authorization: Bearer wh_...` API key, or a `wh_session` cookie. All of the rules (key hashing, revoked
 * keys, suspended workspaces, rate limits) are the auth module's (access.ts); this only reads the request. Failures are thrown as
 * the auth module's AuthError and shaped by the controller's exception filter.
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
