import { Inject, Injectable } from "@nestjs/common";
import { onboarding } from "@wheelhouse/shared/onboarding";
import type { Actor } from "../../common/actor";
import { bad, text } from "../../lib/web-input";
import { RepositoriesService } from "../github/index";
import { TeamAccessService } from "../teams/index";
import { deleteTerm } from "./decisions";
import { markFresh } from "./freshness";
import { deleteEdge, deleteFlow, deleteNode, upsertNode } from "./graph";
import { activityView, askAs, connectAs, graphView, saveLayoutAs, upsertDecisionAs, upsertFlowAs, upsertNodeAs, upsertTermAs } from "./map-app";
import { resolveDraft } from "./sync";

/**
 * What the map area (the knowledge map, its decisions and glossary, drafts and the briefing) can do, as the one door to it: the
 * controller (and, later, other modules through this module's index.ts) calls this, never the functions in this folder
 * directly. For now each method hands over to the function of the same name with the same arguments and answer; folding the
 * functions into service methods can wait (docs/nest-architecture.md).
 */
@Injectable()
export class MapService {
  constructor(
    @Inject(TeamAccessService) private readonly teams: TeamAccessService,
    @Inject(RepositoriesService) private readonly repositories: RepositoriesService,
  ) {}

  /** The onboarding wizard: the team, whether it already has a repository, and the commands to paste (with this team's key in them). */
  async onboardingPage(actor: Actor, teamKey: string, origin: string) {
    const team = await this.teams.require(actor, teamKey);
    const repos = await this.repositories.listRepositories(actor, teamKey);
    return { team: { key: team.key, name: team.name }, hasRepos: repos.length > 0, setup: onboarding({ origin, teamKey }) };
  }

  /**
   * The "no code yet" path: a few sentences about what is being built become the first concept on the map, so a team with no
   * repository still has something there.
   */
  async createConceptAs(actor: Actor, teamKey: string, b: Record<string, unknown>) {
    const description = text(b, "description", { max: 20_000, trim: true });
    if (!description) bad("description", "Write a few sentences about what you're building.");
    const team = await this.teams.require(actor, teamKey, "edit");
    await upsertNode(actor, teamKey, { name: team.name, layer: "concept", kind: "concept", summary: description!.slice(0, 200), purpose: description });
    return { ok: true as const };
  }

  activityView(...a: Parameters<typeof activityView>) {
    return activityView(...a);
  }
  askAs(...a: Parameters<typeof askAs>) {
    return askAs(...a);
  }
  connectAs(...a: Parameters<typeof connectAs>) {
    return connectAs(...a);
  }
  deleteEdge(...a: Parameters<typeof deleteEdge>) {
    return deleteEdge(...a);
  }
  deleteFlow(...a: Parameters<typeof deleteFlow>) {
    return deleteFlow(...a);
  }
  deleteNode(...a: Parameters<typeof deleteNode>) {
    return deleteNode(...a);
  }
  deleteTerm(...a: Parameters<typeof deleteTerm>) {
    return deleteTerm(...a);
  }
  graphView(...a: Parameters<typeof graphView>) {
    return graphView(...a);
  }
  markFresh(...a: Parameters<typeof markFresh>) {
    return markFresh(...a);
  }
  resolveDraft(...a: Parameters<typeof resolveDraft>) {
    return resolveDraft(...a);
  }
  saveLayoutAs(...a: Parameters<typeof saveLayoutAs>) {
    return saveLayoutAs(...a);
  }
  upsertDecisionAs(...a: Parameters<typeof upsertDecisionAs>) {
    return upsertDecisionAs(...a);
  }
  upsertFlowAs(...a: Parameters<typeof upsertFlowAs>) {
    return upsertFlowAs(...a);
  }
  upsertNodeAs(...a: Parameters<typeof upsertNodeAs>) {
    return upsertNodeAs(...a);
  }
  upsertTermAs(...a: Parameters<typeof upsertTermAs>) {
    return upsertTermAs(...a);
  }
}
