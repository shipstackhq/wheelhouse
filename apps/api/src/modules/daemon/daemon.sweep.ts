import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { DeviceChatService } from "./device-chat.service";
import { DeviceJobsService } from "./device-jobs.service";

/** Expires offers nobody took and marks jobs on a device that went silent unreachable, every 15 seconds (the times are in device-common.ts). */
@Injectable()
export class DaemonSweep implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger("DaemonSweep");
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(DeviceJobsService) private readonly jobs: DeviceJobsService,
    @Inject(DeviceChatService) private readonly chats: DeviceChatService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      this.jobs
        .sweep()
        .then((r) => (r.expired || r.unreachable) && this.log.log(`expired ${r.expired} offer(s), ${r.unreachable} job(s) unreachable`))
        .catch((e) => this.log.warn(`sweep failed: ${e instanceof Error ? e.message : e}`));
      this.chats
        .sweep()
        .then((r) => r.failed && this.log.log(`${r.failed} chat answer(s) failed: the device did not answer`))
        .catch((e) => this.log.warn(`chat sweep failed: ${e instanceof Error ? e.message : e}`));
    }, 15_000);
    this.timer.unref();
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }
}
