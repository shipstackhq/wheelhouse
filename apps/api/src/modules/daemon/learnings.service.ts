import { Inject, Injectable } from "@nestjs/common";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { isUuid } from "../../common/uuid";
import { IssuesService } from "../issues/index";
import { TeamAccessService } from "../teams/index";
import { DaemonRepository } from "./daemon.repository";
import { LEARNINGS_CAP, NOTE_MAX } from "./daemon.rules";
import { str } from "./device-common";

/**
 * WH-124: what a team has taught an agent, for people to read, correct and delete. Anyone on the team reads them; editing and deleting
 * take the team's editor role. They are the agent's notes for this team only: another team's are never read here.
 */
@Injectable()
export class LearningsService {
  constructor(
    @Inject(DaemonRepository) private readonly repo: DaemonRepository,
    @Inject(TeamAccessService) private readonly access: TeamAccessService,
    @Inject(IssuesService) private readonly issues: IssuesService,
  ) {}

  private async scope(actor: Actor, teamKey: string, slug: string, need: "read" | "edit") {
    const team = await this.access.require(actor, teamKey, need);
    const agentId = await this.issues.rosterAgentId(team.id, slug);
    if (!agentId) throw new ServiceError("not_found", "That agent is not on this team");
    return { team, agentId };
  }

  async list(actor: Actor, teamKey: string, slug: string) {
    const { team, agentId } = await this.scope(actor, teamKey, slug, "read");
    return { learnings: (await this.repo.learningsOf(team.id, agentId)).map((l) => ({ id: l.id, note: l.note, createdAt: l.createdAt })), cap: LEARNINGS_CAP };
  }

  async update(actor: Actor, teamKey: string, slug: string, id: string, note: unknown) {
    const { team, agentId } = await this.scope(actor, teamKey, slug, "edit");
    const text = str(note, NOTE_MAX).replace(/\s+/g, " ");
    if (!text) throw new ServiceError("invalid", "A learning needs some text", { fields: { note: "required" } });
    const row = isUuid(id) ? await this.repo.updateLearning(id, team.id, agentId, text) : undefined;
    if (!row) throw new ServiceError("not_found", "Learning not found");
    return { learning: { id: row.id, note: row.note, createdAt: row.createdAt } };
  }

  async remove(actor: Actor, teamKey: string, slug: string, id: string) {
    const { team, agentId } = await this.scope(actor, teamKey, slug, "edit");
    if (!isUuid(id) || !(await this.repo.deleteLearning(id, team.id, agentId))) throw new ServiceError("not_found", "Learning not found");
    return { ok: true };
  }
}
