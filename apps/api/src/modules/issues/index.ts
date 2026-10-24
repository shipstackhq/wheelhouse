// The issues module's public surface: the only file another module may import. The Nest module class is not exported here, so a plain helper's importer never loads this module's controllers; app.imports.ts imports it from issues.module (docs/nest-architecture.md).
// The services are what converted modules inject; the plain functions are shims for the callers not converted yet (issues.legacy.ts) and go when the last one moves.
export { IssuesService, type IssueWithLinks, type IssueRelative } from "./issues.service";
export { CyclesService } from "./cycles.service";
export { ProjectsService } from "./projects.service";
export { InitiativesService } from "./initiatives.service";
export { getBoard, getIssue, resolveIssue } from "./issues.legacy";
