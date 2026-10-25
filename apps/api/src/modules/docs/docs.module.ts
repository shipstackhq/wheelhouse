import { Inject, Module, type OnModuleInit } from "@nestjs/common";
import { EventsModule } from "../../platform/events/events.module";
import { MapModule } from "../map/map.module";
import { TeamsModule } from "../teams/teams.module";
import { DocFreshnessService } from "./doc-freshness.service";
import { bindDocsLegacy } from "./docs.legacy";
import { DocsController } from "./docs.controller";
import { DocsListeners } from "./docs.listeners";
import { DocsRepository } from "./docs.repository";
import { DocsService } from "./docs.service";

/** Workspace documentation: the person's side only (/api/app/teams/:key/docs), so it is part of the api role. It depends on the map module (the graph, node lookups, landed hashes, sessions) and listens to its events (`DocsListeners`). */
@Module({
  imports: [EventsModule, TeamsModule, MapModule],
  controllers: [DocsController],
  providers: [DocsRepository, DocsService, DocFreshnessService, DocsListeners],
  exports: [DocsService, DocFreshnessService],
})
export class DocsModule implements OnModuleInit {
  constructor(
    @Inject(DocsService) private readonly docs: DocsService,
    @Inject(DocFreshnessService) private readonly freshness: DocFreshnessService,
  ) {}

  /** Points the legacy functions (docs.legacy.ts) at the live service. */
  onModuleInit() {
    bindDocsLegacy(this.docs, this.freshness);
  }
}
