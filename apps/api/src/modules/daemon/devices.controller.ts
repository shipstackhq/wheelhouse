import { Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { AppEndpoints } from "../../common/decorators/app-endpoints.decorator";
import { type SessionRequest } from "../../common/guards/session.guard";
import { DaemonService } from "./daemon.service";
import { JsonBody } from "../../common/decorators/json-body.decorator";
import type { JsonObject } from "../../common/body";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { approveDeviceDto, denyDeviceDto, type ApproveDeviceDto, type DenyDeviceDto } from "./dto/daemon.dto";

/** The person's machines (the agent daemon), pairing one, and running an issue on one. A device or job of someone else's is a 404. */
@Controller("api/app")
@AppEndpoints()
export class DevicesController {
  constructor(@Inject(DaemonService) private readonly daemon: DaemonService) {}

  @Get("devices")
  async list(@Req() req: SessionRequest) {
    return { devices: await this.daemon.listDevices(req.human.actor) };
  }

  /** The machine behind a pairing code, before it is approved. */
  @Get("devices/pair")
  peek(@Req() req: SessionRequest, @Query("code") code: string) {
    return this.daemon.peekPairing(req.human.actor, code);
  }

  /** `{ code, name? }`: approve the machine into this workspace. */
  @Post("devices/pair")
  @HttpCode(201)
  approve(@Req() req: SessionRequest, @JsonBody(new ZodValidationPipe(approveDeviceDto)) body: ApproveDeviceDto) {
    return this.daemon.approvePairing(req.human.actor, body.code, { name: body.name });
  }

  /** `{ code }`: this is not my machine. */
  @Post("devices/pair/deny")
  @HttpCode(200)
  deny(@Req() req: SessionRequest, @JsonBody(new ZodValidationPipe(denyDeviceDto)) body: DenyDeviceDto) {
    return this.daemon.denyPairing(req.human.actor, body.code);
  }

  /** `{ name?, poolSize?, chatModel? }`. */
  @Patch("devices/:id")
  update(@Req() req: SessionRequest, @Param("id") id: string, @JsonBody() body: JsonObject) {
    return this.daemon.updateDevice(req.human.actor, id, body);
  }

  /** Unpair: its token stops working and what it was running is canceled. */
  @Delete("devices/:id")
  @HttpCode(200)
  revoke(@Req() req: SessionRequest, @Param("id") id: string) {
    return this.daemon.revokeDevice(req.human.actor, id);
  }

  /** The issue's runs, and the devices, repositories and models a new run can use. */
  @Get("issues/:ref/jobs")
  jobs(@Req() req: SessionRequest, @Param("ref") ref: string) {
    return this.daemon.issueJobs(req.human.actor, ref);
  }

  /** The branches a run in `repositoryId` can start from (from GitHub, the default branch first). */
  @Get("issues/:ref/jobs/branches")
  branches(@Req() req: SessionRequest, @Param("ref") ref: string, @Query("repositoryId") repositoryId: string) {
    return this.daemon.runBranches(req.human.actor, ref, repositoryId ?? "");
  }

  /** `{ deviceId, repositoryId?, model, baseBranch? }`: Run on device. */
  @Post("issues/:ref/jobs")
  @HttpCode(201)
  run(@Req() req: SessionRequest, @Param("ref") ref: string, @JsonBody() body: JsonObject) {
    return this.daemon.runOnDevice(req.human.actor, ref, body);
  }

  /** A run's progress after `after` (an event number). */
  @Get("jobs/:id/events")
  events(@Req() req: SessionRequest, @Param("id") id: string, @Query("after") after?: string) {
    const n = after !== undefined && /^\d{1,9}$/.test(after) ? Number(after) : undefined;
    return this.daemon.jobEvents(req.human.actor, id, { after: n });
  }

  @Post("jobs/:id/cancel")
  @HttpCode(200)
  cancel(@Req() req: SessionRequest, @Param("id") id: string) {
    return this.daemon.cancelJob(req.human.actor, id);
  }

  /** Mark an unreachable run lost, by hand. */
  @Post("jobs/:id/mark-lost")
  @HttpCode(200)
  markLost(@Req() req: SessionRequest, @Param("id") id: string) {
    return this.daemon.markJobLost(req.human.actor, id);
  }
}
