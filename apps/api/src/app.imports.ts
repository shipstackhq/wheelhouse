import type { DynamicModule, Type } from "@nestjs/common";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { LegacyApiModule } from "./legacy-api.module";
import { DaemonModule } from "./modules/daemon/daemon.module";
import { AuthModule } from "./modules/auth/auth.module";
import { DashboardModule } from "./modules/dashboard/dashboard.module";
import { DocsModule } from "./modules/docs/docs.module";
import { ImagesModule } from "./modules/images/images.module";
import { GithubModule } from "./modules/github/github.module";
import { IssuesModule } from "./modules/issues/issues.module";
import { MapModule } from "./modules/map/map.module";
import { TeamsModule } from "./modules/teams/teams.module";
import { ConfigModule } from "./platform/config/config.module";
import { servesApi, type ServiceRole } from "./platform/config/service-role";
import { DatabaseModule } from "./platform/database/database.module";
import { EventsModule } from "./platform/events/events.module";
import { StreamApiModule } from "./platform/streams/stream-api.module";

/**
 * AppModule's imports for a role, a pure function so the choice is testable. The platform modules are in every role (`EventEmitterModule.forRoot()` is registered here, once: it is global, and modules tell each other that something happened with `emitAsync` and `@OnEvent`). The legacy
 * group goes before the daemon module on purpose: /api/app routes are matched in the order modules are registered, and the devices
 * routes have always come after the rest.
 */
export function buildAppImports(role: ServiceRole): Array<Type | DynamicModule> {
  return [ConfigModule, DatabaseModule, EventsModule, EventEmitterModule.forRoot(), ...(servesApi(role) ? [LegacyApiModule, StreamApiModule, ImagesModule, TeamsModule, DocsModule, IssuesModule, MapModule, GithubModule, AuthModule, DashboardModule] : []), DaemonModule.register(role)];
}
