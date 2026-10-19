import { Module } from "@nestjs/common";
import { ActorGuard } from "./auth/actor.guard";
import { DatabaseService } from "./database/database.service";
import { HumanGuard } from "./auth/human.guard";
import { GithubController } from "./github/github.controller";
import { WebhookController } from "./github/webhook.controller";
import { HealthController } from "./health/health.controller";
import { McpController } from "./mcp/mcp.controller";
import { StreamController } from "./stream/stream.controller";
import { StreamRegistry } from "./stream/stream.registry";
import { V1Controller } from "./v1/v1.controller";
import { AdminController } from "./web/admin.controller";
import { AuthController } from "./web/auth.controller";
import { BoardController } from "./web/board.controller";
import { DashboardController } from "./web/dashboard.controller";
import { InvitesController } from "./web/invites.controller";
import { KeysController } from "./web/keys.controller";
import { TeamController } from "./web/team.controller";
import { TicketsController } from "./web/tickets.controller";
import { CsrfGuard, SessionGuard } from "./web/endpoints";
import { DocsController } from "./web/docs.controller";
import { MapController } from "./web/map.controller";
import { RepositoriesController } from "./web/repositories.controller";
import { MeController } from "./web/me.controller";
import { ProjectMembersController } from "./web/project-members.controller";
import { ProjectsController } from "./web/projects.controller";

@Module({
  controllers: [HealthController, McpController, V1Controller, WebhookController, GithubController, StreamController, AuthController, MeController, ProjectsController, ProjectMembersController, AdminController, DashboardController, InvitesController, KeysController, TeamController, BoardController, TicketsController, MapController, DocsController, RepositoriesController],
  providers: [DatabaseService, ActorGuard, HumanGuard, StreamRegistry, CsrfGuard, SessionGuard],
})
export class AppModule {}
