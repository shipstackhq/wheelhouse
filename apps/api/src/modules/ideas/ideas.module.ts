import { Module } from "@nestjs/common";
import { IssuesModule } from "../issues/issues.module";
import { TeamsModule } from "../teams/teams.module";
import { IdeasController } from "./ideas.controller";
import { IdeasRepository } from "./ideas.repository";
import { IdeasService } from "./ideas.service";

/** Ideas: the person's side only (/api/app/ideas), so it is part of the api role. Promoting one files an issue through the issues module. */
@Module({
  imports: [TeamsModule, IssuesModule],
  controllers: [IdeasController],
  providers: [IdeasRepository, IdeasService],
})
export class IdeasModule {}
