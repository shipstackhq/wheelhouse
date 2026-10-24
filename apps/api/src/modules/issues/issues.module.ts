import { Inject, Module, type OnModuleInit } from "@nestjs/common";
import { Database } from "../../platform/database/database";
import { EventsModule } from "../../platform/events/events.module";
import { GithubModule } from "../github/github.module";
import { MapModule } from "../map/map.module";
import { TeamsModule } from "../teams/teams.module";
import { BoardController } from "./board.controller";
import { CyclesController } from "./cycles.controller";
import { CyclesRepository } from "./cycles.repository";
import { CyclesService } from "./cycles.service";
import { InitiativesController } from "./initiatives.controller";
import { InitiativesRepository } from "./initiatives.repository";
import { InitiativesService } from "./initiatives.service";
import { IssuesController } from "./issues.controller";
import { bindIssuesLegacy } from "./issues.legacy";
import { IssuesListeners } from "./issues.listeners";
import { IssuesRepository } from "./issues.repository";
import { IssuesService } from "./issues.service";
import { ProjectsController } from "./projects.controller";
import { ProjectsRepository } from "./projects.repository";
import { ProjectsService } from "./projects.service";

/**
 * Issues and the board, cycles, projects and initiatives around them: the person's side only (/api/app), so it is part of the api role.
 * An issue shows its pull requests and links to map nodes, so this module depends on the github and map modules; github reaches it only
 * through events (`IssuesListeners`), and the map never reaches it (its graph only reads the `issue_nodes` table).
 */
@Module({
  imports: [EventsModule, TeamsModule, GithubModule, MapModule],
  controllers: [BoardController, IssuesController, CyclesController, ProjectsController, InitiativesController],
  providers: [IssuesRepository, CyclesRepository, ProjectsRepository, InitiativesRepository, IssuesService, CyclesService, ProjectsService, InitiativesService, IssuesListeners],
  exports: [IssuesService, CyclesService, ProjectsService, InitiativesService],
})
export class IssuesModule implements OnModuleInit {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(IssuesService) private readonly issues: IssuesService,
    @Inject(CyclesService) private readonly cycles: CyclesService,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(InitiativesService) private readonly initiatives: InitiativesService,
  ) {}

  /** Points the legacy functions (issues.legacy.ts) at the live services. */
  onModuleInit() {
    bindIssuesLegacy({ db: this.db, issues: this.issues, cycles: this.cycles, projects: this.projects, initiatives: this.initiatives });
  }
}
