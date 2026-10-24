import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { SESSION_COOKIE } from "../../modules/auth/auth-core";
import { cookieValue } from "../http/cookies";
import { checkCsrf, configuredOrigins, CSRF_HEADER, CsrfError } from "../http/csrf";

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
