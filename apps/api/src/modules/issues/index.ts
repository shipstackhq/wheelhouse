// The issues module's public surface: the only file another module may import. The Nest module class is not exported here, so a plain helper's importer never loads this module's controllers; app.imports.ts imports it from issues.module (docs/nest-architecture.md).
export { IssuesService } from "./issues.service";
export { addComment, getBoard, getIssue, moveIssue, resolveIssue } from "./issues";
