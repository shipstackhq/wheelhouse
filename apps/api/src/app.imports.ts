import type { DynamicModule, Type } from "@nestjs/common";
import { LegacyApiModule } from "./legacy-api.module";
import { DaemonModule } from "./modules/daemon";
import { DocsModule } from "./modules/docs";
import { GithubModule } from "./modules/github";
import { IssuesModule } from "./modules/issues";
import { MapModule } from "./modules/map";
import { TeamsModule } from "./modules/teams";
import { ConfigModule } from "./platform/config/config.module";
import { servesApi, type ServiceRole } from "./platform/config/service-role";
import { DatabaseModule } from "./platform/database/database.module";
import { EventsModule } from "./platform/events/events.module";

/**
 * AppModule's imports for a role, a pure function so the choice is testable. The platform modules are in every role. The legacy
 * group goes before the daemon module on purpose: /api/app routes are matched in the order modules are registered, and the devices
 * routes have always come after the rest.
 */
export function buildAppImports(role: ServiceRole): Array<Type | DynamicModule> {
  return [ConfigModule, DatabaseModule, EventsModule, ...(servesApi(role) ? [LegacyApiModule, TeamsModule, DocsModule, IssuesModule, MapModule, GithubModule] : []), DaemonModule.register(role)];
}
