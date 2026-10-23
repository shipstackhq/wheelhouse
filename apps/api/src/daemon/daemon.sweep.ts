import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { sweepDeviceJobs } from "@wheelhouse/core/lib/daemon";

/** Expires offers nobody took and marks jobs on a device that went silent unreachable, every 15 seconds (the times are in @wheelhouse/core/lib/daemon). */
@Injectable()
export class DaemonSweep implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger("DaemonSweep");
  private timer: ReturnType<typeof setInterval> | null = null;

  onModuleInit() {
    this.timer = setInterval(() => {
      sweepDeviceJobs()
        .then((r) => (r.expired || r.unreachable) && this.log.log(`expired ${r.expired} offer(s), ${r.unreachable} job(s) unreachable`))
        .catch((e) => this.log.warn(`sweep failed: ${e instanceof Error ? e.message : e}`));
    }, 15_000);
    this.timer.unref();
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }
}
