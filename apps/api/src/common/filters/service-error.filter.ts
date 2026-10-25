import { Catch, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";
import { appFailure } from "../errors/api-errors";
import { ServiceError } from "../service-error";

/**
 * Renders a ServiceError the way the app answers it today: the same status and `{ error: { code, message, details? } }` that
 * core's appFailure gives (it is called here, not copied, so the mapping lives in one place). Other exceptions are not caught.
 */
@Catch(ServiceError)
export class ServiceErrorFilter implements ExceptionFilter {
  catch(e: ServiceError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const f = appFailure(e);
    res.status(f.status).set(f.headers ?? {}).json(f.body);
  }
}
