import { Inject, Module, type OnModuleInit } from "@nestjs/common";
import { EventsModule } from "../../platform/events/events.module";
import { TeamsModule } from "../teams/teams.module";
import { ConnectService } from "./connect.service";
import { DeliveriesService } from "./deliveries.service";
import { GithubController } from "./github.controller";
import { bindGithubLegacy } from "./github.legacy";
import { GithubRepository } from "./github.repository";
import { RepositoriesController } from "./repositories.controller";
import { RepositoriesService } from "./repositories.service";
import { WebhookController } from "./webhook.controller";

/** GitHub: the connect flow, the webhook and a team's repositories, all on the person's and GitHub's side, so it is part of the api role. */
@Module({
  imports: [EventsModule, TeamsModule],
  controllers: [WebhookController, GithubController, RepositoriesController],
  providers: [GithubRepository, RepositoriesService, ConnectService, DeliveriesService],
  exports: [RepositoriesService, ConnectService, DeliveriesService],
})
export class GithubModule implements OnModuleInit {
  constructor(
    @Inject(RepositoriesService) private readonly repositories: RepositoriesService,
    @Inject(DeliveriesService) private readonly deliveries: DeliveriesService,
  ) {}

  /** Points the legacy functions (github.legacy.ts) at the live services. */
  onModuleInit() {
    bindGithubLegacy({ repositories: this.repositories, deliveries: this.deliveries });
  }
}
