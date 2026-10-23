import { Module, type DynamicModule, type Provider, type Type } from "@nestjs/common";
import { servesApi, servesDaemon, type ServiceRole } from "../../platform/config/service-role";
import { StreamsModule } from "../../platform/streams/streams.module";
import { DaemonController } from "./daemon.controller";
import { DaemonService } from "./daemon.service";
import { DaemonSweep } from "./daemon.sweep";
import { DeviceGuard } from "./device.guard";
import { DevicesController } from "./devices.controller";

/**
 * The controllers a process of this role serves: the paired machine's API (/api/daemon) where the daemon role runs, and the
 * person's side (/api/app/devices, runs on an issue) where the api role runs, since that is where sessions and CSRF live.
 */
export const daemonControllers = (role: ServiceRole): Type[] => [...(servesDaemon(role) ? [DaemonController] : []), ...(servesApi(role) ? [DevicesController] : [])];

/** The service everywhere; the device guard and the sweep (the timer that expires offers and marks quiet devices' jobs) only where the daemon role runs, so it ticks in one process. */
export const daemonProviders = (role: ServiceRole): Provider[] => [DaemonService, ...(servesDaemon(role) ? [DeviceGuard, DaemonSweep] : [])];

@Module({})
export class DaemonModule {
  static register(role: ServiceRole): DynamicModule {
    return { module: DaemonModule, imports: [StreamsModule], controllers: daemonControllers(role), providers: daemonProviders(role), exports: [DaemonService] };
  }
}
