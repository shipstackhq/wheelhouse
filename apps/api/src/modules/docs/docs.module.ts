import { Inject, Module, type OnModuleInit } from "@nestjs/common";
import { EventsModule } from "../../platform/events/events.module";
import { TeamsModule } from "../teams/teams.module";
import { bindDocsLegacy } from "./docs.legacy";
import { DocsController } from "./docs.controller";
import { DocsRepository } from "./docs.repository";
import { DocsService } from "./docs.service";

/** Workspace documentation: the person's side only (/api/app/teams/:key/docs), so it is part of the api role. */
@Module({
  imports: [EventsModule, TeamsModule],
  controllers: [DocsController],
  providers: [DocsRepository, DocsService],
  exports: [DocsService],
})
export class DocsModule implements OnModuleInit {
  constructor(@Inject(DocsService) private readonly docs: DocsService) {}

  /** Points the legacy functions (docs.legacy.ts) at the live service. */
  onModuleInit() {
    bindDocsLegacy(this.docs);
  }
}
