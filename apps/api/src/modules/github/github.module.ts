import { Module } from "@nestjs/common";
import { GithubController } from "./github.controller";
import { GithubService } from "./github.service";
import { RepositoriesController } from "./repositories.controller";
import { WebhookController } from "./webhook.controller";

/** GitHub: the connect flow, the webhook and a team's repositories, all on the person's and GitHub's side, so it is part of the api role. */
@Module({ controllers: [WebhookController, GithubController, RepositoriesController], providers: [GithubService], exports: [GithubService] })
export class GithubModule {}
