// The teams module's public surface: the only file another module may import. The Nest module class is not exported here, so a plain helper's importer never loads this module's controllers; app.imports.ts imports it from teams.module (docs/nest-architecture.md).
// The services are what converted modules inject; the plain functions are shims for the callers not converted yet (teams.legacy.ts) and go when the last one moves.
export { TeamAccessService } from "./team-access.service";
export { TeamsService } from "./teams.service";
export { TeamMembersService } from "./team-members.service";
export { audit, listTeams, requireTeam, roleOnTeam, teamRoleMap, visibleTeamIds, workspaceRoleOf } from "./teams.legacy";
