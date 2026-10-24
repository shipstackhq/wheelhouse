import { Catch, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";
import { appFailure } from "../../lib/api-errors";
import { DeviceAuthError } from "./internal";

/** The daemon API's failures: the web app's envelope, with 401 `unauthorized` (and a `WWW-Authenticate`) for a bad or expired device token. */
@Catch()
export class DaemonExceptionFilter implements ExceptionFilter {
  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (e instanceof DeviceAuthError) {
      res.status(401).set("WWW-Authenticate", 'Bearer realm="wheelhouse-daemon"').json({ error: { code: "unauthorized", message: e.message } });
      return;
    }
    const f = appFailure(e);
    res.status(f.status).set(f.headers ?? {}).json(f.body);
  }
}
