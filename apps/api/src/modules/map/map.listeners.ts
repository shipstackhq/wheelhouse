import { Inject, Injectable } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { PUSH_LANDED, REPOSITORY_CHANGED, type PushLanded, type RepositoryChanged } from "../github/index";
import { FreshnessService } from "./freshness.service";
import { GraphService } from "./graph.service";

type NodeStatus = "planned" | "building" | "live" | "deprecated";
const LIFECYCLE_STATUS: Record<RepositoryChanged["repository"]["lifecycle"], NodeStatus> = { live: "live", being_replaced: "deprecated", planned: "planned", retired: "deprecated" };

/**
 * What the map does when github says something happened (github.events.ts). `suppressErrors: false` so a failure here fails the github
 * call that emitted the event, as a direct call would have (the default logs the error and goes on).
 */
@Injectable()
export class MapListeners {
  constructor(
    @Inject(GraphService) private readonly graph: GraphService,
    @Inject(FreshnessService) private readonly freshness: FreshnessService,
  ) {}

  /** A repository has a system node on the map. */
  @OnEvent(REPOSITORY_CHANGED, { suppressErrors: false })
  async onRepositoryChanged({ actor, teamId, repository }: RepositoryChanged) {
    await this.graph.upsertNode(actor, teamId, {
      name: repository.displayName,
      layer: "system",
      kind: "service",
      summary: `Repository: ${repository.role}`,
      anchors: [`${repository.slug}:**`],
      status: LIFECYCLE_STATUS[repository.lifecycle],
    });
  }

  /** Files pushed to a connected repository's default branch land on the map. */
  @OnEvent(PUSH_LANDED, { suppressErrors: false })
  async onPushLanded({ actor, teamKey, sha, branch, files, repository }: PushLanded) {
    await this.freshness.land(actor, teamKey, { sha, branch, files, repository });
  }
}
