import { Module } from "@nestjs/common";
import { ActorGuard } from "./auth/actor.guard";
import { HumanGuard } from "./auth/human.guard";
import { GithubController } from "./github/github.controller";
import { WebhookController } from "./github/webhook.controller";
import { McpController } from "./mcp/mcp.controller";
import { StreamsModule } from "./platform/streams/streams.module";
import { StreamController } from "./stream/stream.controller";
import { V1Controller } from "./v1/v1.controller";
import { AdminController } from "./web/admin.controller";
import { AuthController } from "./web/auth.controller";
import { BoardController } from "./web/board.controller";
import { CyclesController } from "./web/cycles.controller";
import { DashboardController } from "./web/dashboard.controller";
import { CsrfGuard, SessionGuard } from "./web/endpoints";
import { ImagesController } from "./web/images.controller";
import { InitiativesController } from "./web/initiatives.controller";
import { InvitesController } from "./web/invites.controller";
import { IssuesController } from "./web/issues.controller";
import { KeysController } from "./web/keys.controller";
import { MapController } from "./web/map.controller";
import { MeController } from "./web/me.controller";
import { ProjectsController } from "./web/projects.controller";
import { RepositoriesController } from "./web/repositories.controller";
import { WorkspaceController } from "./web/workspace.controller";

/**
 * Every controller that has not moved into its own module yet (docs/nest-architecture.md: strangler). They are the "api" role's
 * part of the app, so one switch (SERVICE_ROLE) turns the whole group off in a process that only serves machines. As an area gets
 * its own module under modules/, its controllers leave this list.
 */
@Module({
  imports: [StreamsModule],
  controllers: [McpController, V1Controller, WebhookController, GithubController, StreamController, AuthController, MeController, ImagesController, AdminController, DashboardController, InvitesController, KeysController, WorkspaceController, BoardController, IssuesController, MapController, RepositoriesController, CyclesController, ProjectsController, InitiativesController],
  providers: [ActorGuard, HumanGuard, CsrfGuard, SessionGuard],
})
export class LegacyApiModule {}
