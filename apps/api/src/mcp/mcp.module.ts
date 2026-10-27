import { Module } from "@nestjs/common";
import { ActorGuard } from "../common/guards/actor.guard";
import { HumanGuard } from "../common/guards/human.guard";
import { McpController } from "./mcp.controller";
import { V1Controller } from "../v1/v1.controller";
import { TeamsModule } from "../modules/teams/teams.module";
import { IssuesModule } from "../modules/issues/issues.module";
import { MapModule } from "../modules/map/map.module";
import { DocsModule } from "../modules/docs/docs.module";
import { GithubModule } from "../modules/github/github.module";
import { DashboardModule } from "../modules/dashboard/dashboard.module";
import { ToolsService } from "../lib/tools";
import { CsrfGuard } from "../common/guards/csrf.guard";
import { SessionGuard } from "../common/guards/session.guard";

/**
 * MCP and the REST twin of its tools (`/mcp`, `/api/v1`), the "api" role's agent-facing part: one switch (SERVICE_ROLE) turns it off in a
 * process that only serves machines. `ToolsService` builds the tool registry from the module services, so the module imports their modules.
 */
@Module({
  imports: [TeamsModule, IssuesModule, MapModule, DocsModule, GithubModule, DashboardModule],
  controllers: [McpController, V1Controller],
  providers: [ToolsService, ActorGuard, HumanGuard, CsrfGuard, SessionGuard],
})
export class McpModule {}
