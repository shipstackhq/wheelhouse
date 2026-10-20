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
import { WorkspaceController } from "./web/workspace.controller";
import { IssuesController } from "./web/issues.controller";
import { CsrfGuard, SessionGuard } from "./web/endpoints";
import { DocsController } from "./web/docs.controller";
import { MapController } from "./web/map.controller";
import { RepositoriesController } from "./web/repositories.controller";
import { CyclesController } from "./web/cycles.controller";
import { ProjectsController } from "./web/projects.controller";
import { InitiativesController } from "./web/initiatives.controller";
import { MeController } from "./web/me.controller";
import { TeamMembersController } from "./web/team-members.controller";
import { TeamsController } from "./web/teams.controller";

@Module({
  controllers: [HealthController, McpController, V1Controller, WebhookController, GithubController, StreamController, AuthController, MeController, TeamsController, TeamMembersController, AdminController, DashboardController, InvitesController, KeysController, WorkspaceController, BoardController, IssuesController, MapController, DocsController, RepositoriesController, CyclesController, ProjectsController, InitiativesController],
  providers: [DatabaseService, ActorGuard, HumanGuard, StreamRegistry, CsrfGuard, SessionGuard],
})
export class AppModule {}
