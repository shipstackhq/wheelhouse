import type { TeamRole, Role } from "@wheelhouse/api-client";

/** Workspace roles in the order they are offered (ADR-23). A role decides what a person can do around teams; it opens none by itself. */
export const WORKSPACE_ROLES: { value: Role; label: string; hint: string }[] = [
  { value: "owner", label: "owner", hint: "Everything, including other owners and billing" },
  { value: "admin", label: "admin", hint: "Invites people, changes roles, reads the access log, joins any team as admin" },
  { value: "member", label: "member", hint: "Creates teams and works in the teams they are in" },
  { value: "viewer", label: "viewer", hint: "Read only, in the teams they are in" },
  { value: "guest", label: "guest", hint: "Only the teams they are added to; sees no directory of people" },
];

/** The roles a person can hand out: only an owner can make an owner. */
export const assignableRoles = (mine: Role) => WORKSPACE_ROLES.filter((r) => r.value !== "owner" || mine === "owner");

export const canManagePeople = (role: Role | null | undefined) => role === "owner" || role === "admin";

export const TEAM_ROLES: { value: TeamRole; label: string; hint: string }[] = [
  { value: "admin", label: "admin", hint: "Manages who is in the team, its settings and repositories" },
  { value: "editor", label: "editor", hint: "Creates and edits tickets, docs, the map and decisions" },
  { value: "viewer", label: "viewer", hint: "Reads everything and comments" },
];

const ROLE_VALUES = new Set<string>(WORKSPACE_ROLES.map((r) => r.value));
export const asRole = (v: unknown, fallback: Role = "member"): Role => (typeof v === "string" && ROLE_VALUES.has(v) ? (v as Role) : fallback);
