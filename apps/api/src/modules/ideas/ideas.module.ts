import { Module } from "@nestjs/common";
import { IssuesModule } from "../issues/issues.module";
import { TeamsModule } from "../teams/teams.module";
import { IdeasController } from "./ideas.controller";
import { IdeasRepository } from "./ideas.repository";
import { IdeasService } from "./ideas.service";

/** Ideas: the person's side (/api/app/ideas) and, through MCP, agents filing one (create_idea). Promoting one files an issue through the issues module. */
@Module({
  imports: [TeamsModule, IssuesModule],
  controllers: [IdeasController],
  providers: [IdeasRepository, IdeasService],
  exports: [IdeasService],
})
export class IdeasModule {}
