import { Catch, Controller, Get, HttpCode, Inject, Injectable, Param, Post, Req, Res, UseFilters, UseGuards, type ArgumentsHost, type CanActivate, type ExceptionFilter, type ExecutionContext } from "@nestjs/common";
import { Readable } from "node:stream";
import type { Request, Response } from "express";
import { appFailure } from "@wheelhouse/core/lib/api-errors";
import {
  acceptJob,
  DeviceAuthError,
  deviceForToken,
  deviceHeartbeat,
  deviceHello,
  deviceStream,
  exchangeAssertion,
  finishJob,
  parseLastEventId,
  pollPairing,
  recordJobEvents,
  rejectJob,
  startPairing,
  type Device,
} from "@wheelhouse/core/lib/daemon";
import { SSE_HEADERS } from "@wheelhouse/core/lib/sse";
import { clientIp } from "@wheelhouse/core/lib/rate-limit";
import type { RawTextRequest } from "../http/raw-text";
import { toHeaders } from "../http/util";
import { StreamRegistry } from "../stream/stream.registry";
import { jsonBody } from "../web/body";
import { requestOrigin } from "../web/origin";

/**
 * The agent daemon's API (see wheelhouse-cli/daemon/DESIGN.md). Pairing and the token exchange need no credentials (they are the way
 * in); everything else needs a device token, `Authorization: Bearer whd_...`. No cookies are read here, so there is nothing for CSRF.
 * Failures use the web app's envelope, `{ error: { code, message } }`, with 401 `unauthorized` for a bad or expired token.
 */

type DeviceRequest = Request & RawTextRequest & { device: Device };

@Injectable()
export class DeviceGuard implements CanActivate {
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<DeviceRequest>();
    req.device = await deviceForToken(req.headers.authorization ?? null);
    return true;
  }
}

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

const ip = (req: Request) => clientIp(toHeaders(req.headers));

@Controller("api/daemon")
@UseFilters(DaemonExceptionFilter)
export class DaemonController {
  constructor(@Inject(StreamRegistry) private readonly streams: StreamRegistry) {}

  /** `{ publicKey, name, os }` → the device code to poll with and the code the person types in Wheelhouse. */
  @Post("pair/start")
  @HttpCode(200)
  pairStart(@Req() req: RawTextRequest) {
    return startPairing(jsonBody(req), { ip: ip(req), origin: requestOrigin(req) });
  }

  /** `{ deviceCode }` → `{ status: pending | slow_down | denied | expired }`, or once approved the device id and the server's key. */
  @Post("pair/poll")
  @HttpCode(200)
  pairPoll(@Req() req: RawTextRequest) {
    return pollPairing(jsonBody(req));
  }

  /** `{ assertion }` (an EdDSA JWT signed with the device key) → `{ accessToken, expiresIn }`. */
  @Post("token")
  @HttpCode(200)
  token(@Req() req: RawTextRequest) {
    return exchangeAssertion(jsonBody(req), { ip: ip(req) });
  }

  /** The device's signed messages: replayed from Last-Event-ID, then live. */
  @Get("stream")
  @UseGuards(DeviceGuard)
  stream(@Req() req: DeviceRequest, @Res() res: Response) {
    const gone = new AbortController();
    const untrack = this.streams.track(gone);
    res.on("close", () => {
      gone.abort();
      untrack();
    });
    const last = req.headers["last-event-id"];
    const body = deviceStream(req.device.id, parseLastEventId(Array.isArray(last) ? last[0] : last), gone.signal);
    res.writeHead(200, SSE_HEADERS);
    res.flushHeaders();
    Readable.fromWeb(body as never).pipe(res);
  }

  /** `{ version, capabilities, jobs }`, on every connect. */
  @Post("hello")
  @HttpCode(200)
  @UseGuards(DeviceGuard)
  hello(@Req() req: DeviceRequest) {
    return deviceHello(req.device, jsonBody(req));
  }

  /** `{ running, free, onBattery }`, every 30 seconds. */
  @Post("heartbeat")
  @HttpCode(200)
  @UseGuards(DeviceGuard)
  heartbeat(@Req() req: DeviceRequest) {
    return deviceHeartbeat(req.device, jsonBody(req));
  }

  @Post("jobs/:id/accept")
  @HttpCode(200)
  @UseGuards(DeviceGuard)
  accept(@Req() req: DeviceRequest, @Param("id") id: string) {
    return acceptJob(req.device, id);
  }

  /** `{ reason, detail? }`. */
  @Post("jobs/:id/reject")
  @HttpCode(200)
  @UseGuards(DeviceGuard)
  reject(@Req() req: DeviceRequest, @Param("id") id: string) {
    return rejectJob(req.device, id, jsonBody(req));
  }

  /** `{ events: [{ seq, at, type, data }] }`, batched. */
  @Post("jobs/:id/events")
  @HttpCode(200)
  @UseGuards(DeviceGuard)
  events(@Req() req: DeviceRequest, @Param("id") id: string) {
    return recordJobEvents(req.device, id, jsonBody(req));
  }

  /** `{ state, commit?, pushed?, diffStats?, costUsd?, durationMs?, error? }`. */
  @Post("jobs/:id/finish")
  @HttpCode(200)
  @UseGuards(DeviceGuard)
  finish(@Req() req: DeviceRequest, @Param("id") id: string) {
    return finishJob(req.device, id, jsonBody(req));
  }
}
