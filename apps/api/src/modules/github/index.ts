// The github module's public surface: the only file another module may import. The Nest module class is not exported here, so a plain helper's importer never loads this module's controllers; app.imports.ts imports it from github.module (docs/nest-architecture.md).
// The services are what converted modules inject; the plain functions are shims for the callers not converted yet (github.legacy.ts) and go when the last one moves.
export { RepositoriesService, type RepositoryInput } from "./repositories.service";
export { ConnectService } from "./connect.service";
export { DeliveriesService } from "./deliveries.service";
export { GithubApiError, type GithubApi } from "./api";
export { github } from "./runtime";
export { findOrCreateRepository, listRepositories, pullRequestsForIssue } from "./github.legacy";
export { REPOSITORY_CHANGED, PUSH_LANDED, type RepositoryChanged, type PushLanded } from "./github.events";
export type { RepositoryRow } from "./github.repository";
