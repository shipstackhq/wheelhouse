// The dashboard module's public surface: the only file another module may import. The Nest module class is not exported here, so a plain helper's importer never loads this module's controllers; app.imports.ts imports it from dashboard.module (docs/nest-architecture.md).
export { DashboardService } from "./dashboard.service";
export { checklistBriefingLine, type ChecklistState } from "./setup-checklist";
export { checklistForTeam } from "./checklist";
