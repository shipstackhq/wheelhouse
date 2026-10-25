// The dashboard module's public surface: the only file another module may import. The Nest module class is not exported here, so a plain helper's importer never loads this module's controllers; app.imports.ts imports it from dashboard.module (docs/nest-architecture.md).
// Nothing imports the dashboard module's services yet (it sits on top of the others); the plain functions are shims for the tools (dashboard.legacy.ts) and go with the MCP redesign.
export { DashboardService } from "./dashboard.service";
export { BriefingService } from "./briefing.service";
export { ChecklistService } from "./checklist.service";
export { checklistBriefingLine, type ChecklistState } from "./setup-checklist";
export { briefing, issueContext } from "./dashboard.legacy";
