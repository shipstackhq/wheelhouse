import { Module, type DynamicModule, type Provider, type Type } from "@nestjs/common";
import { servesApi, servesDaemon, type ServiceRole } from "../../platform/config/service-role";
import { StreamsModule } from "../../platform/streams/streams.module";
import { GithubModule } from "../github/github.module";
import { IssuesModule } from "../issues/issues.module";
import { NotificationsCoreModule } from "../notifications/index";
import { TeamsModule } from "../teams/teams.module";
import { ChatController } from "./chat.controller";
import { ChatService } from "./chat.service";
import { DeviceChatService } from "./device-chat.service";
import { DaemonController } from "./daemon.controller";
import { DaemonRepository } from "./daemon.repository";
import { DaemonSweep } from "./daemon.sweep";
import { DeviceAuthService } from "./device-auth.service";
import { DeviceJobsService } from "./device-jobs.service";
import { DeviceStreamService } from "./device-stream.service";
import { DeviceGuard } from "./device.guard";
import { DevicesController } from "./devices.controller";
import { DevicesService } from "./devices.service";
import { RunNotifications } from "./runs.notifications";
import { RunsService } from "./runs.service";

/**
 * The controllers a process of this role serves: the paired machine's API (/api/daemon) where the daemon role runs, and the
 * person's side (/api/app/devices, runs on an issue) where the api role runs, since that is where sessions and CSRF live.
 */
export const daemonControllers = (role: ServiceRole): Type[] => [...(servesDaemon(role) ? [DaemonController] : []), ...(servesApi(role) ? [DevicesController, ChatController] : [])];

/**
 * The machine side (device auth, the guard, the stream, jobs, the sweep) depends only on this module's own providers and the platform
 * layer (and the inbox, a leaf module every role loads, which tells the person who started a run how it ended), so a process with `SERVICE_ROLE=daemon` loads no other domain module. The machine's services are also here in the api
 * role (the person's runs send a device its offers and move its jobs, and the tests call them there). The guard and the sweep (the timer that expires offers
 * and marks quiet devices' jobs) only where the daemon role runs, so it ticks in one process. The person's side (devices, runs) only in the api role.
 */
export const daemonProviders = (role: ServiceRole): Provider[] => [
  DaemonRepository,
  DeviceStreamService,
  DeviceJobsService,
  DeviceChatService,
  RunNotifications,
  DeviceAuthService,
  ...(servesDaemon(role) ? [DeviceGuard, DaemonSweep] : []),
  ...(servesApi(role) ? [DevicesService, RunsService, ChatService] : []),
];

@Module({})
export class DaemonModule {
  static register(role: ServiceRole): DynamicModule {
    // Teams, issues and github are loaded by the api role already; the person's services use them, the machine's never do.
    const imports = [StreamsModule, NotificationsCoreModule, ...(servesApi(role) ? [TeamsModule, IssuesModule, GithubModule] : [])];
    return { module: DaemonModule, imports, controllers: daemonControllers(role), providers: daemonProviders(role), exports: [] };
  }
}
