// The teams module's public surface: the only file another module may import. The Nest module class is not exported here, so a plain helper's importer never loads this module's controllers; app.imports.ts imports it from teams.module (docs/nest-architecture.md).
export { TeamsService } from "./teams.service";
export { requireTeam } from "./teams";
export { audit, roleOnTeam, teamRoleMap, visibleTeamIds, workspaceRoleOf } from "./team-access";
export { listTeams } from "./teams";
