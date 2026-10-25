import { Catch, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";
import { appFailure } from "../errors/api-errors";
import { CsrfError } from "../http/csrf";

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
