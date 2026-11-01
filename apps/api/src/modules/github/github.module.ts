import { Inject, Module, type OnApplicationBootstrap, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { PrSyncService } from "./pr-sync.service";
import { CiPolicyService } from "./ci-policy.service";
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

const DETECT_EVERY_MS = 24 * 60 * 60 * 1000;

/** GitHub: the connect flow, the webhook and a team's repositories, all on the person's and GitHub's side, so it is part of the api role. */
@Module({
  imports: [EventsModule, TeamsModule],
  controllers: [WebhookController, GithubController, RepositoriesController],
  providers: [GithubRepository, RepositoriesService, ConnectService, DeliveriesService, PrSyncService, CiPolicyService],
  exports: [RepositoriesService, ConnectService, DeliveriesService, PrSyncService],
})
export class GithubModule implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    @Inject(RepositoriesService) private readonly repositories: RepositoriesService,
    @Inject(DeliveriesService) private readonly deliveries: DeliveriesService,
    @Inject(PrSyncService) private readonly prSync: PrSyncService,
    @Inject(CiPolicyService) private readonly ci: CiPolicyService,
  ) {}

  /** Points the legacy functions (github.legacy.ts) at the live services. */
  onModuleInit() {
    bindGithubLegacy({ repositories: this.repositories, deliveries: this.deliveries });
  }

  /** Once on server start, catch up on pull requests webhooks missed, and read each repository's CI (then again daily). Not awaited: it must not hold up startup, and it never throws. */
  onApplicationBootstrap() {
    void this.prSync.syncAll();
    void this.ci.detectAll();
    this.timer = setInterval(() => void this.ci.detectAll(), DETECT_EVERY_MS);
    this.timer.unref();
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }
}
