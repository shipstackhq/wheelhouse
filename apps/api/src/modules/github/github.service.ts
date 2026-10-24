import { Injectable } from "@nestjs/common";
import { finishConnect, startConnect } from "./connect";
import { browseRepoTreeAs, connectGithubAs, createConceptAs, createRepositoryAs, githubStatus, listRepositoriesAs, onboardingPage, retireRepositoryAs, updateRepositoryAs } from "./repositories-app";
import { receiveWebhook } from "./webhook";

/**
 * What the github area (connecting GitHub, its webhook and the repositories) can do, as the one door to it: the controllers (and,
 * later, other modules through this module's index.ts) call this, never the functions in this folder directly. For now each
 * method hands over to the function of the same name with the same arguments and answer; folding the functions into service
 * methods can wait (docs/nest-architecture.md).
 */
@Injectable()
export class GithubService {
  browseRepoTreeAs(...a: Parameters<typeof browseRepoTreeAs>) {
    return browseRepoTreeAs(...a);
  }
  connectGithubAs(...a: Parameters<typeof connectGithubAs>) {
    return connectGithubAs(...a);
  }
  createConceptAs(...a: Parameters<typeof createConceptAs>) {
    return createConceptAs(...a);
  }
  createRepositoryAs(...a: Parameters<typeof createRepositoryAs>) {
    return createRepositoryAs(...a);
  }
  finishConnect(...a: Parameters<typeof finishConnect>) {
    return finishConnect(...a);
  }
  githubStatus(...a: Parameters<typeof githubStatus>) {
    return githubStatus(...a);
  }
  listRepositoriesAs(...a: Parameters<typeof listRepositoriesAs>) {
    return listRepositoriesAs(...a);
  }
  onboardingPage(...a: Parameters<typeof onboardingPage>) {
    return onboardingPage(...a);
  }
  receiveWebhook(...a: Parameters<typeof receiveWebhook>) {
    return receiveWebhook(...a);
  }
  retireRepositoryAs(...a: Parameters<typeof retireRepositoryAs>) {
    return retireRepositoryAs(...a);
  }
  startConnect(...a: Parameters<typeof startConnect>) {
    return startConnect(...a);
  }
  updateRepositoryAs(...a: Parameters<typeof updateRepositoryAs>) {
    return updateRepositoryAs(...a);
  }
}
