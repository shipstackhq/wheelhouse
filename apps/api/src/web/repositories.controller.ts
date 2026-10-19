import { Controller, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { browseRepoTreeAs, connectGithubAs, createConceptAs, createRepositoryAs, githubStatus, listRepositoriesAs, onboardingPage, retireRepositoryAs, updateRepositoryAs } from "@wheelhouse/core/lib/docs-app";
import type { RawTextRequest } from "../http/raw-text";
import { jsonBody } from "./body";
import { AppEndpoints, SessionGuard, type SessionRequest } from "./endpoints";
import { requestOrigin } from "./origin";

/** The repositories page, the Connect GitHub card, and the onboarding wizard. A project or repository of another workspace is a 404. */
@Controller("api/app/projects")
@AppEndpoints()
@UseGuards(SessionGuard)
export class RepositoriesController {
  @Get(":key/repositories")
  async list(@Req() req: SessionRequest, @Param("key") key: string) {
    return { repositories: await listRepositoriesAs(req.human.actor, key) };
  }

  /** `{ displayName, role, provider?, defaultBranch?, pathLimit?, lifecycle? }`: a repository linked by hand. */
  @Post(":key/repositories")
  async create(@Req() req: SessionRequest & RawTextRequest, @Param("key") key: string) {
    return { repository: await createRepositoryAs(req.human.actor, key, jsonBody(req)) };
  }

  /**
   * Connect GitHub: whether the server has the App, and (for owners) each installation of the workspace with the repositories this
   * project could still connect. Everything is asked of GitHub on the way in, so it is never stale.
   */
  @Get(":key/repositories/github")
  githubConnectStatus(@Req() req: SessionRequest, @Param("key") key: string) {
    return githubStatus(req.human, key);
  }

  /** `{ installationId, repoId, role?, pathLimit? }`. Owners only; the installation must be the workspace's own (ADR-12). Name and branch come from GitHub. */
  @Post(":key/repositories/github")
  async connectGithub(@Req() req: SessionRequest & RawTextRequest, @Param("key") key: string) {
    return { repository: await connectGithubAs(req.human.actor, key, jsonBody(req)) };
  }

  @Patch(":key/repositories/:id")
  async update(@Req() req: SessionRequest & RawTextRequest, @Param("key") key: string, @Param("id") id: string) {
    return { repository: await updateRepositoryAs(req.human.actor, key, id, jsonBody(req)) };
  }

  @Post(":key/repositories/:id/retire")
  @HttpCode(200)
  async retire(@Req() req: SessionRequest, @Param("key") key: string, @Param("id") id: string) {
    return { repository: await retireRepositoryAs(req.human.actor, key, id) };
  }

  /** The file paths of a connected GitHub repository, for the doc anchor picker. */
  @Get(":key/repositories/:id/tree")
  tree(@Req() req: SessionRequest, @Param("key") key: string, @Param("id") id: string) {
    return browseRepoTreeAs(req.human.actor, key, id);
  }

  /** The wizard's data: the project, whether it has a repository, and the commands to paste with this project's key in them. */
  @Get(":key/onboarding")
  onboarding(@Req() req: SessionRequest, @Param("key") key: string) {
    return onboardingPage(req.human.actor, key, requestOrigin(req));
  }

  /** `{ description }`: the "no code yet" path, a few sentences that become the map's first concept. */
  @Post(":key/onboarding/concept")
  @HttpCode(200)
  concept(@Req() req: SessionRequest & RawTextRequest, @Param("key") key: string) {
    return createConceptAs(req.human.actor, key, jsonBody(req));
  }
}
