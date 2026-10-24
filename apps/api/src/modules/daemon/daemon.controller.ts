import { Controller, Get, HttpCode, Inject, Param, Post, Req, Res, UseFilters, UseGuards } from "@nestjs/common";
import { Readable } from "node:stream";
import type { Request, Response } from "express";
import { SSE_HEADERS } from "../../platform/streams/sse";
import { clientIp } from "../../common/rate-limit";
import { toHeaders } from "../../common/http/cookies";
import { StreamRegistry } from "../../platform/streams/stream.registry";
import { requestOrigin } from "../../common/http/origin";
import { DaemonExceptionFilter } from "./daemon-exception.filter";
import { parseLastEventId } from "./daemon.rules";
import { DeviceAuthService } from "./device-auth.service";
import { DeviceJobsService } from "./device-jobs.service";
import { DeviceStreamService } from "./device-stream.service";
import { DeviceGuard, type DeviceRequest } from "./device.guard";
import { JsonBody } from "../../common/decorators/json-body.decorator";
import type { JsonObject } from "../../common/body";

/**
 * The agent daemon's API (see wheelhouse-cli/daemon/DESIGN.md). Pairing and the token exchange need no credentials (they are the way
 * in); everything else needs a device token, `Authorization: Bearer whd_...`. No cookies are read here, so there is nothing for CSRF.
 * Failures use the web app's envelope, `{ error: { code, message } }`, with 401 `unauthorized` for a bad or expired token.
 */

const ip = (req: Request) => clientIp(toHeaders(req.headers));

@Controller("api/daemon")
@UseFilters(DaemonExceptionFilter)
export class DaemonController {
  constructor(
    @Inject(StreamRegistry) private readonly streams: StreamRegistry,
    @Inject(DeviceAuthService) private readonly auth: DeviceAuthService,
    @Inject(DeviceStreamService) private readonly messages: DeviceStreamService,
    @Inject(DeviceJobsService) private readonly jobs: DeviceJobsService,
  ) {}

  /** `{ publicKey, name, os }` → the device code to poll with and the code the person types in Wheelhouse. */
  @Post("pair/start")
  @HttpCode(200)
  pairStart(@Req() req: Request, @JsonBody() body: JsonObject) {
    return this.auth.startPairing(body, { ip: ip(req), origin: requestOrigin(req) });
  }

  /** `{ deviceCode }` → `{ status: pending | slow_down | denied | expired }`, or once approved the device id and the server's key. */
  @Post("pair/poll")
  @HttpCode(200)
  pairPoll(@JsonBody() body: JsonObject) {
    return this.auth.pollPairing(body);
  }

  /** `{ assertion }` (an EdDSA JWT signed with the device key) → `{ accessToken, expiresIn }`. */
  @Post("token")
  @HttpCode(200)
  token(@Req() req: Request, @JsonBody() body: JsonObject) {
    return this.auth.exchangeAssertion(body, { ip: ip(req) });
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
    const body = this.messages.stream(req.device.id, parseLastEventId(Array.isArray(last) ? last[0] : last), gone.signal);
    res.writeHead(200, SSE_HEADERS);
    res.flushHeaders();
    Readable.fromWeb(body as never).pipe(res);
  }

  /** `{ version, capabilities, jobs }`, on every connect. */
  @Post("hello")
  @HttpCode(200)
  @UseGuards(DeviceGuard)
  hello(@Req() req: DeviceRequest, @JsonBody() body: JsonObject) {
    return this.jobs.hello(req.device, body);
  }

  /** `{ running, free, onBattery }`, every 30 seconds. */
  @Post("heartbeat")
  @HttpCode(200)
  @UseGuards(DeviceGuard)
  heartbeat(@Req() req: DeviceRequest, @JsonBody() body: JsonObject) {
    return this.jobs.heartbeat(req.device, body);
  }

  @Post("jobs/:id/accept")
  @HttpCode(200)
  @UseGuards(DeviceGuard)
  accept(@Req() req: DeviceRequest, @Param("id") id: string) {
    return this.jobs.acceptJob(req.device, id);
  }

  /** `{ reason, detail? }`. */
  @Post("jobs/:id/reject")
  @HttpCode(200)
  @UseGuards(DeviceGuard)
  reject(@Req() req: DeviceRequest, @Param("id") id: string, @JsonBody() body: JsonObject) {
    return this.jobs.rejectJob(req.device, id, body);
  }

  /** `{ events: [{ seq, at, type, data }] }`, batched. */
  @Post("jobs/:id/events")
  @HttpCode(200)
  @UseGuards(DeviceGuard)
  events(@Req() req: DeviceRequest, @Param("id") id: string, @JsonBody() body: JsonObject) {
    return this.jobs.recordJobEvents(req.device, id, body);
  }

  /** `{ state, commit?, pushed?, diffStats?, costUsd?, durationMs?, error? }`. */
  @Post("jobs/:id/finish")
  @HttpCode(200)
  @UseGuards(DeviceGuard)
  finish(@Req() req: DeviceRequest, @Param("id") id: string, @JsonBody() body: JsonObject) {
    return this.jobs.finishJob(req.device, id, body);
  }
}
