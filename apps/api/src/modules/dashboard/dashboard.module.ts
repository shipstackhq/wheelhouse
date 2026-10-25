import { Inject, Module, type OnModuleInit } from "@nestjs/common";
import { DocsModule } from "../docs/docs.module";
import { GithubModule } from "../github/github.module";
import { IssuesModule } from "../issues/issues.module";
import { MapModule } from "../map/map.module";
import { TeamsModule } from "../teams/teams.module";
import { BriefingService } from "./briefing.service";
import { ChecklistService } from "./checklist.service";
import { DashboardController } from "./dashboard.controller";
import { bindDashboardLegacy } from "./dashboard.legacy";
import { DashboardRepository } from "./dashboard.repository";
import { DashboardService } from "./dashboard.service";
import { MetricsService } from "./metrics.service";
import { TeamPageController } from "./team-page.controller";

/**
 * The read models that look across areas: the dashboard's widgets (metrics), a team's setup checklist, the team page and the agent
 * briefing. Nothing here writes; the person's side only, so it is part of the api role. It sits on top of the other modules: it
 * calls their services, and reads their tables only for the aggregates (`DashboardRepository`).
 */
@Module({
  imports: [TeamsModule, MapModule, IssuesModule, DocsModule, GithubModule],
  controllers: [DashboardController, TeamPageController],
  providers: [DashboardRepository, MetricsService, ChecklistService, BriefingService, DashboardService],
  exports: [DashboardService, MetricsService, ChecklistService, BriefingService],
})
export class DashboardModule implements OnModuleInit {
  constructor(@Inject(BriefingService) private readonly briefing: BriefingService) {}

  /** Points the legacy functions (dashboard.legacy.ts) at the live service. */
  onModuleInit() {
    bindDashboardLegacy(this.briefing);
  }
}
