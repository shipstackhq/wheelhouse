import { Inject, Module, type OnModuleInit } from "@nestjs/common";
import { EventsModule } from "../../platform/events/events.module";
import { GithubModule } from "../github/github.module";
import { TeamsModule } from "../teams/teams.module";
import { BriefingService } from "./briefing.service";
import { DecisionsService } from "./decisions.service";
import { FreshnessService } from "./freshness.service";
import { GraphService } from "./graph.service";
import { MapController } from "./map.controller";
import { bindMapLegacy } from "./map.legacy";
import { MapListeners } from "./map.listeners";
import { MapRepository } from "./map.repository";
import { SessionsService } from "./sessions.service";
import { Database } from "../../platform/database/database";

/** The knowledge map and what hangs off it: the person's side only (/api/app/teams/:key/map and its decisions, glossary and drafts), so it is part of the api role. It depends on the github module (a repository is found or created for a report) and listens to its events. */
@Module({
  imports: [EventsModule, TeamsModule, GithubModule],
  controllers: [MapController],
  providers: [MapRepository, GraphService, DecisionsService, FreshnessService, SessionsService, BriefingService, MapListeners],
  exports: [GraphService, DecisionsService, FreshnessService, SessionsService, BriefingService],
})
export class MapModule implements OnModuleInit {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(GraphService) private readonly graph: GraphService,
    @Inject(DecisionsService) private readonly decisions: DecisionsService,
    @Inject(FreshnessService) private readonly freshness: FreshnessService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(BriefingService) private readonly briefing: BriefingService,
  ) {}

  /** Points the legacy functions (map.legacy.ts) at the live services. */
  onModuleInit() {
    bindMapLegacy({ db: this.db, graph: this.graph, decisions: this.decisions, freshness: this.freshness, sessions: this.sessions, briefing: this.briefing });
  }
}
