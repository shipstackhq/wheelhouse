// The issues module's public surface: the only file another module may import. The Nest module class is not exported here, so a plain helper's importer never loads this module's controllers; app.imports.ts imports it from issues.module (docs/nest-architecture.md).
// The services are what converted modules inject. The plain functions (issues.legacy.ts) are shims for the tests, which import that file directly.
export { IssuesService, type IssueWithLinks, type IssueRelative } from "./issues.service";
export { CyclesService } from "./cycles/cycles.service";
export { ProjectsService } from "./projects/projects.service";
export { InitiativesService } from "./initiatives/initiatives.service";
export { boardView } from "./issues.presenter";
