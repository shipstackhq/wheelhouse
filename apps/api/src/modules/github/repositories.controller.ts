import { Controller, Delete, Inject, Get, HttpCode, Param, Patch, Post, Req } from "@nestjs/common";
import { AppEndpoints } from "../../common/decorators/app-endpoints.decorator";
import { type SessionRequest } from "../../common/guards/session.guard";
import { ConnectService } from "./connect.service";
import { repositoryView } from "./github.presenter";
import { PrSyncService } from "./pr-sync.service";
import { RepositoriesService } from "./repositories.service";
import { JsonBody } from "../../common/decorators/json-body.decorator";
import type { JsonObject } from "../../common/body";

/** The repositories page and the Connect GitHub card. A team or repository of another workspace is a 404. */
@Controller("api/app/teams")
@AppEndpoints()
export class RepositoriesController {
  constructor(
    @Inject(RepositoriesService) private readonly repositories: RepositoriesService,
    @Inject(ConnectService) private readonly connect: ConnectService,
    @Inject(PrSyncService) private readonly prSync: PrSyncService,
  ) {}

  @Get(":key/repositories")
  async list(@Req() req: SessionRequest, @Param("key") key: string) {
    return { repositories: (await this.repositories.listRepositories(req.human.actor, key)).map(repositoryView) };
  }

  /** `{ displayName, role, provider?, defaultBranch?, pathLimit?, lifecycle? }`: a repository linked by hand. */
  @Post(":key/repositories")
  async create(@Req() req: SessionRequest, @Param("key") key: string, @JsonBody() body: JsonObject) {
    return { repository: repositoryView(await this.repositories.createRepositoryAs(req.human.actor, key, body)) };
  }

  /**
   * Connect GitHub: whether the server has the App, and (for owners) each installation of the workspace with the repositories this
   * team could still connect. Everything is asked of GitHub on the way in, so it is never stale.
   */
  @Get(":key/repositories/github")
  githubConnectStatus(@Req() req: SessionRequest, @Param("key") key: string) {
    return this.connect.githubStatus(req.human, key);
  }

  /** `{ installationId, repoId, role?, pathLimit? }`. Owners only; the installation must be the workspace's own (ADR-12). Name and branch come from GitHub. */
  @Post(":key/repositories/github")
  async connectGithub(@Req() req: SessionRequest, @Param("key") key: string, @JsonBody() body: JsonObject) {
    const repository = await this.connect.connectGithubAs(req.human.actor, key, body);
    await this.prSync.syncRepository(repository.id); // its pull requests are read right away; a failure is logged, never thrown
    return { repository: repositoryView((await this.repositories.listRepositories(req.human.actor, key)).find((r) => r.id === repository.id) ?? repository) };
  }

  /** Sync pull requests: read every connected repository's open and recently closed pull requests from GitHub ("check again now"). */
  @Post(":key/repositories/github/sync")
  @HttpCode(200)
  async syncPullRequests(@Req() req: SessionRequest, @Param("key") key: string) {
    const results = await this.prSync.syncTeam(req.human.actor, key);
    return { results, repositories: (await this.repositories.listRepositories(req.human.actor, key)).map(repositoryView) };
  }

  /** This workspace stops using an installation; other workspaces linked to it keep it. Owners only. */
  @Delete(":key/repositories/github/:installationId")
  disconnectGithub(@Req() req: SessionRequest, @Param("installationId") installationId: string) {
    return this.connect.unlinkInstallation(req.human.actor, installationId);
  }

  @Patch(":key/repositories/:id")
  async update(@Req() req: SessionRequest, @Param("key") key: string, @Param("id") id: string, @JsonBody() body: JsonObject) {
    return { repository: repositoryView(await this.repositories.updateRepositoryAs(req.human.actor, key, id, body)) };
  }

  @Post(":key/repositories/:id/retire")
  @HttpCode(200)
  async retire(@Req() req: SessionRequest, @Param("key") key: string, @Param("id") id: string) {
    return { repository: repositoryView(await this.repositories.retireRepository(req.human.actor, key, id)) };
  }

  /** The file paths of a connected GitHub repository, for the doc anchor picker. */
  @Get(":key/repositories/:id/tree")
  tree(@Req() req: SessionRequest, @Param("key") key: string, @Param("id") id: string) {
    return this.repositories.browseRepoTreeAs(req.human.actor, key, id);
  }
}
