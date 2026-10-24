import { Module } from "@nestjs/common";
import { StatusesController } from "./statuses.controller";
import { TeamMembersController } from "./team-members.controller";
import { TeamsController } from "./teams.controller";
import { TeamsService } from "./teams.service";

/** Teams, their members and their statuses: the person's side only (/api/app/teams), so it is part of the api role. */
@Module({ controllers: [TeamsController, TeamMembersController, StatusesController], providers: [TeamsService], exports: [TeamsService] })
export class TeamsModule {}
