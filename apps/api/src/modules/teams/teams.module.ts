import { Inject, Module, type OnModuleInit } from "@nestjs/common";
import { Database } from "../../platform/database/database";
import { EventsModule } from "../../platform/events/events.module";
import { StatusesController } from "./statuses.controller";
import { StatusesService } from "./statuses.service";
import { TeamAccessService } from "./team-access.service";
import { TeamLifecycleService } from "./team-lifecycle.service";
import { TeamMembersController } from "./team-members.controller";
import { TeamMembersService } from "./team-members.service";
import { TeamsController } from "./teams.controller";
import { bindTeamsLegacy } from "./teams.legacy";
import { TeamsRepository } from "./teams.repository";
import { TeamsService } from "./teams.service";

/** Teams, their members and their statuses: the person's side only (/api/app/teams), so it is part of the api role. */
@Module({
  imports: [EventsModule],
  controllers: [TeamsController, TeamMembersController, StatusesController],
  providers: [TeamsRepository, TeamAccessService, TeamsService, TeamLifecycleService, TeamMembersService, StatusesService],
  exports: [TeamAccessService, TeamsService, TeamMembersService],
})
export class TeamsModule implements OnModuleInit {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(TeamAccessService) private readonly access: TeamAccessService,
    @Inject(TeamsService) private readonly teams: TeamsService,
    @Inject(TeamLifecycleService) private readonly lifecycle: TeamLifecycleService,
    @Inject(TeamMembersService) private readonly members: TeamMembersService,
    @Inject(StatusesService) private readonly statuses: StatusesService,
  ) {}

  /** Points the legacy functions (teams.legacy.ts) at the live services. */
  onModuleInit() {
    bindTeamsLegacy({ db: this.db, access: this.access, teams: this.teams, lifecycle: this.lifecycle, members: this.members, statuses: this.statuses });
  }
}
