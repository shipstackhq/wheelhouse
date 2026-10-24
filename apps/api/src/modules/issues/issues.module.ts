import { Module } from "@nestjs/common";
import { BoardController } from "./board.controller";
import { CyclesController } from "./cycles.controller";
import { InitiativesController } from "./initiatives.controller";
import { IssuesController } from "./issues.controller";
import { IssuesService } from "./issues.service";
import { ProjectsController } from "./projects.controller";

/** Issues and the board, cycles, projects and initiatives around them: the person's side only (/api/app), so it is part of the api role. */
@Module({ controllers: [BoardController, IssuesController, CyclesController, ProjectsController, InitiativesController], providers: [IssuesService], exports: [IssuesService] })
export class IssuesModule {}
