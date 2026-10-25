import { schema } from "../db";
import type { TeamRole, WorkspaceRole } from "../db/schema";
import { ServiceError } from "./service-error";

/** The pure rules about roles: what a role allows, who may manage people, and the read-only check for a retired team. No database access. */

export type Need = "read" | "edit" | "admin";
const NEED_RANK: Record<Need, number> = { read: 1, edit: 2, admin: 3 };
const ROLE_RANK: Record<TeamRole, number> = { viewer: 1, editor: 2, admin: 3 };

export const roleAllows = (role: TeamRole, need: Need) => ROLE_RANK[role] >= NEED_RANK[need];

/** The role a person really has on a team: a workspace Viewer stays read only whatever role a team gave them. */
export function effectiveRole(teamRole: TeamRole | null, workspaceRole: WorkspaceRole | null): TeamRole | null {
  if (!teamRole || !workspaceRole) return null;
  return workspaceRole === "viewer" ? "viewer" : teamRole;
}

/** Who may invite people, change roles and remove members: owners and admins (ADR-23). Only an owner may make or unmake another owner. */
export const canManagePeople = (role: WorkspaceRole) => role === "owner" || role === "admin";
export const isWorkspaceRole = (v: unknown): v is WorkspaceRole => typeof v === "string" && (schema.WORKSPACE_ROLES as readonly string[]).includes(v);

/** A retired team is read only for everyone, people and agent keys alike (WH-128). Every write path reaches this through `requireTeam` or `resolveIssue`. */
export function assertWritable(team: { key: string; retiredAt: Date | null }) {
  if (team.retiredAt) throw new ServiceError("conflict", `Team ${team.key} is retired and read only. Restore it to make changes.`);
}

/** Throws forbidden when the role cannot do what is asked; the wording says what to ask for. */
export function assertAllows(role: TeamRole, need: Need) {
  if (roleAllows(role, need)) return;
  throw new ServiceError("forbidden", need === "admin" ? "Only a team admin can do that" : "Your role on this team is read only");
}
