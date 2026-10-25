import { uuid, text, timestamp, integer, boolean, jsonb, bigserial, primaryKey, doublePrecision, index, uniqueIndex, unique, foreignKey, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { STATUS_ROLES } from "@wheelhouse/shared/status-roles";
import { TEAM_ICON_COLORS } from "../../modules/teams/team-icon";
import { table, createdAt } from "./common";
import { teamScope } from "./team-scope";
import { users, workspaces, memberships } from "./auth";

/** What a person can do inside one team. */
export const TEAM_ROLES = ["admin", "editor", "viewer"] as const;

export type TeamRole = (typeof TEAM_ROLES)[number];

/**
 * Who can open a team (ADR-23). A team is visible only to the people in this table; there is no open/private flag and
 * no other way in. Only people are listed: an agent key reaches the teams in `api_key_teams` (WH-120).
 * `workspace_id` repeats the team's workspace so every row can be checked against it without a join.
 */
export const teamMembers = table(
  "team_members",
  {
    teamId: uuid("team_id").notNull(),
    userId: uuid("user_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    role: text("role", { enum: TEAM_ROLES }).notNull().default("editor"),
    // Where this person keeps the team in their own sidebar (they drag it); null until they have ordered their teams.
    position: doublePrecision("position"),
    addedBy: uuid("added_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId] }),
    index("team_members_user_idx").on(t.userId, t.workspaceId),
    teamScope("team_members", t),
    // A team member is a workspace member: leaving the workspace removes the person from every team in it.
    foreignKey({ name: "team_members_membership_fk", columns: [t.userId, t.workspaceId], foreignColumns: [memberships.userId, memberships.workspaceId] }).onDelete("cascade"),
  ],
);

/**
 * Append-only record of who changed access: members added, removed or re-roled, teams joined by an administrator. Separate
 * from `events`, which is the product activity feed that agent cursors read; never updated or deleted. `team_id` is null
 * for workspace-level actions and has no foreign key, so a deleted team keeps its history.
 */
/** What an audit entry is about. */
export const AUDIT_TARGET_TYPES = ["user", "team", "membership"] as const;

export const auditEvents = table(
  "audit_events",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    teamId: uuid("team_id"),
    actorKind: text("actor_kind", { enum: ["human", "agent"] }).notNull(),
    actorId: uuid("actor_id"),
    actorName: text("actor_name").notNull(),
    action: text("action").notNull(), // e.g. team.member_added, team.admin_joined, workspace.role_changed
    targetType: text("target_type", { enum: AUDIT_TARGET_TYPES }).notNull(),
    targetId: text("target_id"),
    before: jsonb("before").$type<Record<string, unknown> | null>(),
    after: jsonb("after").$type<Record<string, unknown> | null>(),
    createdAt: createdAt(),
  },
  (t) => [index("audit_events_workspace_seq_idx").on(t.workspaceId, t.seq)],
);

export const teams = table("teams", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  key: text("key").notNull(), // short prefix like "WH" for issue refs
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  // The team's icon in the sidebar: `ri:<name>` (a Remix icon, in `icon_color`) or one emoji; null is the default glyph.
  icon: text("icon"),
  iconColor: text("icon_color", { enum: TEAM_ICON_COLORS }),
  issueCounter: integer("issue_counter").notNull().default(0),
  // The parent team, in the same workspace (composite foreign key below). It places the team in a hierarchy and grants no access (ADR-23).
  parentId: uuid("parent_id"),
  // Set while the team is retired: read-only, kept with all its data and members, restorable (WH-128).
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  retiredBy: uuid("retired_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
}, (t) => [
  unique("teams_id_workspace_id_unique").on(t.id, t.workspaceId),
  foreignKey({ name: "teams_parent_fk", columns: [t.parentId, t.workspaceId], foreignColumns: [t.id, t.workspaceId] }).onDelete("restrict"),
  index("teams_workspace_parent_idx").on(t.workspaceId, t.parentId),
  check("teams_not_own_parent_check", sql`"parent_id" <> "id"`),
  // A team key ("WH") is what an issue ref starts with: one per workspace, whatever its case.
  uniqueIndex("teams_workspace_key_idx").on(t.workspaceId, sql`lower(${t.key})`),
]);

/**
 * A team's statuses (what a board column is): the stages an issue moves through. Any number can share a role; the one with
 * `is_default` is what an automatic move to that role (a merged pull request, "done") picks, so each role has at most one.
 * Names are unique in a team whatever their case, so "Todo" and "todo" cannot both exist.
 */
export const statuses = table("statuses", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  position: doublePrecision("position").notNull(),
  // What stage of work this status stands for (WH-86); rules and reports use it, never the name. Every status has one.
  role: text("role", { enum: STATUS_ROLES }).notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  // The colour of the status's dot, from the team icon palette; null draws the colour of its role.
  color: text("color", { enum: TEAM_ICON_COLORS }),
}, (t) => [
  teamScope("statuses", t),
  uniqueIndex("statuses_team_default_role_idx").on(t.teamId, t.role).where(sql`is_default`),
  uniqueIndex("statuses_team_name_idx").on(t.teamId, sql`lower(${t.name})`),
]);
