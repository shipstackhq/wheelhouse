import { Controller, Inject, Get, HttpCode, Param, Patch, Post, Req } from "@nestjs/common";
import { AppEndpoints } from "../../common/decorators/app-endpoints.decorator";
import { type SessionRequest } from "../../common/guards/session.guard";
import { requestOrigin } from "../../common/http/origin";
import { GithubService } from "./github.service";
import { JsonBody } from "../../common/decorators/json-body.decorator";
import type { JsonObject } from "../../common/body";

/** The repositories page, the Connect GitHub card, and the onboarding wizard. A team or repository of another workspace is a 404. */
@Controller("api/app/teams")
@AppEndpoints()
export class RepositoriesController {
  constructor(@Inject(GithubService) private readonly github: GithubService) {}

  @Get(":key/repositories")
  async list(@Req() req: SessionRequest, @Param("key") key: string) {
    return { repositories: await this.github.listRepositoriesAs(req.human.actor, key) };
  }

  /** `{ displayName, role, provider?, defaultBranch?, pathLimit?, lifecycle? }`: a repository linked by hand. */
  @Post(":key/repositories")
  async create(@Req() req: SessionRequest, @Param("key") key: string, @JsonBody() body: JsonObject) {
    return { repository: await this.github.createRepositoryAs(req.human.actor, key, body) };
  }

  /**
   * Connect GitHub: whether the server has the App, and (for owners) each installation of the workspace with the repositories this
   * team could still connect. Everything is asked of GitHub on the way in, so it is never stale.
   */
  @Get(":key/repositories/github")
  githubConnectStatus(@Req() req: SessionRequest, @Param("key") key: string) {
    return this.github.githubStatus(req.human, key);
  }

  /** `{ installationId, repoId, role?, pathLimit? }`. Owners only; the installation must be the workspace's own (ADR-12). Name and branch come from GitHub. */
  @Post(":key/repositories/github")
  async connectGithub(@Req() req: SessionRequest, @Param("key") key: string, @JsonBody() body: JsonObject) {
    return { repository: await this.github.connectGithubAs(req.human.actor, key, body) };
  }

  @Patch(":key/repositories/:id")
  async update(@Req() req: SessionRequest, @Param("key") key: string, @Param("id") id: string, @JsonBody() body: JsonObject) {
    return { repository: await this.github.updateRepositoryAs(req.human.actor, key, id, body) };
  }

  @Post(":key/repositories/:id/retire")
  @HttpCode(200)
  async retire(@Req() req: SessionRequest, @Param("key") key: string, @Param("id") id: string) {
    return { repository: await this.github.retireRepositoryAs(req.human.actor, key, id) };
  }

  /** The file paths of a connected GitHub repository, for the doc anchor picker. */
  @Get(":key/repositories/:id/tree")
  tree(@Req() req: SessionRequest, @Param("key") key: string, @Param("id") id: string) {
    return this.github.browseRepoTreeAs(req.human.actor, key, id);
  }

  /** The wizard's data: the team, whether it has a repository, and the commands to paste with this team's key in them. */
  @Get(":key/onboarding")
  onboarding(@Req() req: SessionRequest, @Param("key") key: string) {
    return this.github.onboardingPage(req.human.actor, key, requestOrigin(req));
  }

  /** `{ description }`: the "no code yet" path, a few sentences that become the map's first concept. */
  @Post(":key/onboarding/concept")
  @HttpCode(200)
  concept(@Req() req: SessionRequest, @Param("key") key: string, @JsonBody() body: JsonObject) {
    return this.github.createConceptAs(req.human.actor, key, body);
  }
}
