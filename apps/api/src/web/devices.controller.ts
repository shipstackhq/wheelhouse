import { Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { approvePairing, cancelJob, denyPairing, issueJobs, jobEvents, listDevices, markJobLost, peekPairing, revokeDevice, runBranches, runOnDevice, updateDevice } from "@wheelhouse/core/lib/daemon";
import type { RawTextRequest } from "../http/raw-text";
import { jsonBody } from "./body";
import { AppEndpoints, SessionGuard, type SessionRequest } from "./endpoints";

/** The person's machines (the agent daemon), pairing one, and running an issue on one. A device or job of someone else's is a 404. */
@Controller("api/app")
@AppEndpoints()
@UseGuards(SessionGuard)
export class DevicesController {
  @Get("devices")
  async list(@Req() req: SessionRequest) {
    return { devices: await listDevices(req.human.actor) };
  }

  /** The machine behind a pairing code, before it is approved. */
  @Get("devices/pair")
  peek(@Req() req: SessionRequest, @Query("code") code: string) {
    return peekPairing(req.human.actor, code);
  }

  /** `{ code, name? }`: approve the machine into this workspace. */
  @Post("devices/pair")
  @HttpCode(201)
  approve(@Req() req: SessionRequest & RawTextRequest) {
    const b = jsonBody(req);
    return approvePairing(req.human.actor, b.code, { name: b.name });
  }

  /** `{ code }`: this is not my machine. */
  @Post("devices/pair/deny")
  @HttpCode(200)
  deny(@Req() req: SessionRequest & RawTextRequest) {
    return denyPairing(req.human.actor, jsonBody(req).code);
  }

  /** `{ name?, poolSize?, chatModel? }`. */
  @Patch("devices/:id")
  update(@Req() req: SessionRequest & RawTextRequest, @Param("id") id: string) {
    return updateDevice(req.human.actor, id, jsonBody(req));
  }

  /** Unpair: its token stops working and what it was running is canceled. */
  @Delete("devices/:id")
  @HttpCode(200)
  revoke(@Req() req: SessionRequest, @Param("id") id: string) {
    return revokeDevice(req.human.actor, id);
  }

  /** The issue's runs, and the devices, repositories and models a new run can use. */
  @Get("issues/:ref/jobs")
  jobs(@Req() req: SessionRequest, @Param("ref") ref: string) {
    return issueJobs(req.human.actor, ref);
  }

  /** The branches a run in `repositoryId` can start from (from GitHub, the default branch first). */
  @Get("issues/:ref/jobs/branches")
  branches(@Req() req: SessionRequest, @Param("ref") ref: string, @Query("repositoryId") repositoryId: string) {
    return runBranches(req.human.actor, ref, repositoryId ?? "");
  }

  /** `{ deviceId, repositoryId?, model, baseBranch? }`: Run on device. */
  @Post("issues/:ref/jobs")
  @HttpCode(201)
  run(@Req() req: SessionRequest & RawTextRequest, @Param("ref") ref: string) {
    return runOnDevice(req.human.actor, ref, jsonBody(req));
  }

  /** A run's progress after `after` (an event number). */
  @Get("jobs/:id/events")
  events(@Req() req: SessionRequest, @Param("id") id: string, @Query("after") after?: string) {
    const n = after !== undefined && /^\d{1,9}$/.test(after) ? Number(after) : undefined;
    return jobEvents(req.human.actor, id, { after: n });
  }

  @Post("jobs/:id/cancel")
  @HttpCode(200)
  cancel(@Req() req: SessionRequest, @Param("id") id: string) {
    return cancelJob(req.human.actor, id);
  }

  /** Mark an unreachable run lost, by hand. */
  @Post("jobs/:id/mark-lost")
  @HttpCode(200)
  markLost(@Req() req: SessionRequest, @Param("id") id: string) {
    return markJobLost(req.human.actor, id);
  }
}
