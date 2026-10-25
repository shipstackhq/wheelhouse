import { Inject, Injectable } from "@nestjs/common";
import type { Actor } from "../../common/actor";
import { TeamAccessService } from "../teams/index";
import { DashboardRepository } from "./dashboard.repository";
import { checklistStatus, type ChecklistState } from "./setup-checklist";

/**
 * Gathers the rows checklistStatus() needs and computes the team's setup-checklist state. Shared by the team-page banner and the agent
 * briefing so the two can't say different things about what's connected. The team is resolved through TeamAccessService.
 */
@Injectable()
export class ChecklistService {
  constructor(
    @Inject(DashboardRepository) private readonly repo: DashboardRepository,
    @Inject(TeamAccessService) private readonly access: TeamAccessService,
  ) {}

  async forTeam(actor: Actor, teamRef: string): Promise<ChecklistState> {
    const team = await this.access.require(actor, teamRef);
    return checklistStatus({ teamKey: team.key, ...(await this.repo.checklistCounts(team)) });
  }
}
