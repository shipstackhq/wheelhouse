// The github module's public surface: the only file another module may import. The Nest module class is not exported here, so a plain helper's importer never loads this module's controllers; app.imports.ts imports it from github.module (docs/nest-architecture.md).
export { GithubService } from "./github.service";
export { findOrCreateRepository } from "./repositories";
export { GithubApiError, type GithubApi } from "./api";
export { github } from "./runtime";
export { listRepositories } from "./repositories";
