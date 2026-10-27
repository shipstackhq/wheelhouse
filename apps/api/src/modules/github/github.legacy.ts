import type { DeliveriesService } from "./deliveries.service";
import type { RepositoriesService } from "./repositories.service";

/**
 * Temporary. Code that is not converted yet (the issues module) still calls plain
 * functions; these are those functions, each one line forwarding to the live service. `GithubModule.onModuleInit` points them at the
 * services Nest built, so nothing works before the application has booted (tests call `testApp()`). None takes a `q`. Delete this file
 * when the last caller moves to the services.
 */
type Live = { repositories: RepositoriesService; deliveries: DeliveriesService };
let live: Live | undefined;

export function bindGithubLegacy(services: Live) {
  live = services;
}
const s = (): Live => live ?? (() => { throw new Error("The github module is not booted: start the Nest application (tests: await testApp()) before calling the legacy functions"); })();

export const listRepositories = (...a: Parameters<RepositoriesService["listRepositories"]>) => s().repositories.listRepositories(...a);
export const createRepository = (...a: Parameters<RepositoriesService["createRepository"]>) => s().repositories.createRepository(...a);
export const updateRepository = (...a: Parameters<RepositoriesService["updateRepository"]>) => s().repositories.updateRepository(...a);
export const retireRepository = (...a: Parameters<RepositoriesService["retireRepository"]>) => s().repositories.retireRepository(...a);
export const findOrCreateRepository = (...a: Parameters<RepositoriesService["findOrCreateRepository"]>) => s().repositories.findOrCreateRepository(...a);
