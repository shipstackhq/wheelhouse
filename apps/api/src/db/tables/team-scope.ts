import { foreignKey, type AnyPgColumn } from "drizzle-orm/pg-core";
import { teams } from "./teams";

/**
 * A row that belongs to a team also says which workspace that is, and the database makes the two agree: the foreign key is
 * `(team_id, workspace_id)` to the team's own `(id, workspace_id)`, so a row can never point across workspaces (WH-113).
 */
export const teamScope = (table: string, t: { teamId: AnyPgColumn; workspaceId: AnyPgColumn }) =>
  foreignKey({ name: `${table}_team_fk`, columns: [t.teamId, t.workspaceId], foreignColumns: [teams.id, teams.workspaceId] }).onDelete("cascade");
