import { applyDecorators, Catch, Injectable, UseFilters, UseGuards, type ArgumentsHost, type CanActivate, type ExceptionFilter, type ExecutionContext } from "@nestjs/common";
import type { Request, Response } from "express";
import { AuthError } from "../modules/auth/access";
import { appFailure } from "../lib/api-errors";
import { humanFromSession, SESSION_COOKIE, type Human } from "../modules/auth/auth-core";
import { cookieValue } from "../http/util";
import { checkCsrf, configuredOrigins, CSRF_HEADER, CsrfError } from "./csrf";

/**
 * Everything the web app's API (/api/app/*) has in common. A controller gets it all with one decorator:
 *
 *   @Controller("api/app/things") @AppEndpoints() export class ThingsController { ... }
 *
 *  - CSRF check on every state-changing request (see csrf.ts)
 *  - one error envelope: { error: { code, message, details? } }, with the codes and statuses of /api/v1, plus account errors
 *    and `csrf_failed` (403). Field problems are details.fields = { name: message }; a conflict carries details.current.
 * Add `@UseGuards(SessionGuard)` to a route (or the controller) that needs a signed-in person.
 */

const header = (req: Request, name: string) => {
  const v = req.headers[name];
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
};

@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly allowedOrigins = configuredOrigins();

  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request>();
    const v = checkCsrf({
      method: req.method,
      origin: header(req, "origin"),
      referer: header(req, "referer"),
      host: header(req, "host"),
      tokenHeader: header(req, CSRF_HEADER),
      sessionToken: cookieValue(req.headers.cookie, SESSION_COOKIE),
      allowedOrigins: this.allowedOrigins,
    });
    if (!v.ok) throw new CsrfError(v.reason);
    return true;
  }
}

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

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (e instanceof CsrfError) {
      res.status(403).json({ error: { code: "csrf_failed", message: e.message } });
      return;
    }
    const f = appFailure(e);
    res.status(f.status).set(f.headers ?? {}).json(f.body);
  }
}

export const AppEndpoints = () => applyDecorators(UseGuards(CsrfGuard), UseFilters(AppExceptionFilter));
