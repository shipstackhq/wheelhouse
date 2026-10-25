import { Controller, Get, Inject, Query, Req, UseFilters, UseGuards } from "@nestjs/common";
import { ActorGuard, type AuthedRequest } from "../../common/guards/actor.guard";
import { ServiceError } from "../../common/service-error";
import { V1ExceptionFilter } from "../../v1/v1.controller";
import { AgentsService } from "./agents.service";

/** For the plugin: a team's agents as Claude Code subagent files. An API key reaches only the teams it is scoped to. */
@Controller("api/v1")
@UseFilters(V1ExceptionFilter)
export class AgentsV1Controller {
  constructor(@Inject(AgentsService) private readonly agents: AgentsService) {}

  /** `?team=KEY` -> `{ files: [{ name, content }] }`, empty while the workspace has agents off. */
  @Get("team-agents")
  @UseGuards(ActorGuard)
  async teamAgents(@Req() req: AuthedRequest, @Query("team") team?: string) {
    if (!team) throw new ServiceError("invalid", "team is required", { fields: { team: "required" } });
    return this.agents.subagentFiles(req.actor, team);
  }
}
