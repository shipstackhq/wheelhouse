import { Module } from "@nestjs/common";
import { EventsModule } from "../../platform/events/events.module";
import { TeamsModule } from "../teams/teams.module";
import { AgentsController } from "./agents.controller";
import { AgentsV1Controller } from "./agents-v1.controller";
import { AgentsRepository } from "./agents.repository";
import { AgentsService } from "./agents.service";

/** Agents and team rosters: the person's side (/api/app) and the plugin's read (/api/v1/team-agents), so part of the api role. */
@Module({
  imports: [EventsModule, TeamsModule],
  controllers: [AgentsController, AgentsV1Controller],
  providers: [AgentsRepository, AgentsService],
})
export class AgentsModule {}
