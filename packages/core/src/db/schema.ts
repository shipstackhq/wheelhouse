import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  bigserial,
  bigint,
  primaryKey,
  doublePrecision,
  index,
  uniqueIndex,
  unique,
  foreignKey,
  type AnyPgColumn,
  type PgColumn,
  check,
  date,
  pgView,
} from "drizzle-orm/pg-core";
import { STATUS_ROLES } from "../lib/status-roles";
import { TEAM_ICON_COLORS } from "../lib/team-icon";
import { sql } from "drizzle-orm";

/**
 * `pgTable`, plus a CHECK constraint for every column declared with an `enum`: the TypeScript values are the source of
 * truth and the database refuses anything else (WH-114). The constraint is named `<table>_<column>_check`; a test compares
 * each one in the database with its enum.
 */
const table = ((name: string, columns: Record<string, unknown>, extra?: (t: never) => unknown[]) =>
  pgTable(name, columns as never, (t) => {
    // The columns handed to this callback are wrappers: the enum is on their `config`.
    const enumOf = (c: PgColumn) => ((c as unknown as { config?: { enumValues?: string[] } }).config?.enumValues ?? c.enumValues) as string[] | undefined;
    const checks = (Object.values(t) as PgColumn[])
      .filter((c) => (enumOf(c)?.length ?? 0) > 0)
      .map((c) => check(`${name}_${c.name}_check`, sql.raw(`"${c.name}" in (${enumOf(c)!.map((v) => `'${v}'`).join(", ")})`)));
    return [...checks, ...((extra ? extra(t as never) : []) as never[])];
  })) as unknown as typeof pgTable;

/**
 * Workspace roles (ADR-23). A role decides what a person may do around teams (create them, manage people, pay); it never
 * opens a team by itself: that takes a row in `team_members`.
 */
export const WORKSPACE_ROLES = ["owner", "admin", "member", "viewer", "guest"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** What a person can do inside one team. */
export const TEAM_ROLES = ["admin", "editor", "viewer"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

/**
 * A row that belongs to a team also says which workspace that is, and the database makes the two agree: the foreign key is
 * `(team_id, workspace_id)` to the team's own `(id, workspace_id)`, so a row can never point across workspaces (WH-113).
 */
const teamScope = (table: string, t: { teamId: AnyPgColumn; workspaceId: AnyPgColumn }) =>
  foreignKey({ name: `${table}_team_fk`, columns: [t.teamId, t.workspaceId], foreignColumns: [teams.id, teams.workspaceId] }).onDelete("cascade");

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const users = table("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: createdAt(),
}, (t) => [
  // `email` is unique as written; this makes it unique however it is cased, so the code lower-casing it is not what holds it.
  uniqueIndex("users_email_lower_idx").on(sql`lower(${t.email})`),
]);

export const sessions = table("sessions", {
  id: text("id").primaryKey(), // sha256 of the cookie token
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  // The workspace this session is working in, for a person who belongs to several (ADR-23). Null: their first one.
  activeWorkspaceId: uuid("active_workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

export const workspaces = table("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  // The workspace's address (`/w/<slug>` later). Created from the name; the default only keeps rows that skip it unique.
  slug: text("slug").notNull().unique().default(sql`replace(gen_random_uuid()::text, '-', '')`),
  // Seats, owner included. Null: the instance default (MAX_WORKSPACE_MEMBERS).
  seatLimit: integer("seat_limit"),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
  // Instance-admin suspension (WH-52): a suspended workspace's members cannot sign in and its API keys are refused.
  // Reversible: nothing is deleted, restoring clears these three columns.
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  suspendedBy: uuid("suspended_by").references(() => users.id, { onDelete: "set null" }),
  suspendedReason: text("suspended_reason"),
});

export const memberships = table(
  "memberships",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    role: text("role", { enum: WORKSPACE_ROLES }).notNull().default("member"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.workspaceId] })],
);

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

// Invite-only signup (WH-49). Only the SHA-256 of the token is stored; the plain token is shown once.
// kind new_workspace: the invitee gets a fresh workspace and owns it. kind join_workspace: the invitee joins workspace_id.
export const invites = table(
  "invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind", { enum: ["new_workspace", "join_workspace"] }).notNull(),
    email: text("email").notNull(), // lower-cased; the account is created with exactly this address
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }), // join_workspace only
    workspaceName: text("workspace_name"), // new_workspace only (optional)
    role: text("role", { enum: WORKSPACE_ROLES }).notNull().default("member"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    tokenHash: text("token_hash").notNull().unique(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    usedBy: uuid("used_by").references(() => users.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("invites_workspace_idx").on(t.workspaceId, t.usedAt), unique("invites_id_workspace_id_unique").on(t.id, t.workspaceId)],
);

/**
 * join_workspace invites only: the teams the person is put into when they accept, each with a team role (ADR-23). One row per
 * team; the invite and the team must be in the same workspace, and deleting either removes the row.
 */
export const inviteTeams = table(
  "invite_teams",
  {
    inviteId: uuid("invite_id").notNull(),
    teamId: uuid("team_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    role: text("role", { enum: TEAM_ROLES }).notNull().default("editor"),
  },
  (t) => [
    primaryKey({ columns: [t.inviteId, t.teamId] }),
    teamScope("invite_teams", t),
    foreignKey({ name: "invite_teams_invite_fk", columns: [t.inviteId, t.workspaceId], foreignColumns: [invites.id, invites.workspaceId] }).onDelete("cascade"),
  ],
);

export const apiKeys = table("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(), // first chars, shown in UI
  keyHash: text("key_hash").notNull().unique(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  // Capability flags for this key (WH-51). Keys default to none set, i.e. read-only: a key must be
  // explicitly marked "docs:write" by a teammate before upsert_doc/delete_doc will work for it.
  capabilities: jsonb("capabilities").$type<string[]>().notNull().default([]),
  createdAt: createdAt(),
}, (t) => [unique("api_keys_id_workspace_id_unique").on(t.id, t.workspaceId)]);

/**
 * The teams an agent key can open (WH-120). A key reaches a team only through a row here, as an editor; a key with no rows reaches
 * nothing. Both ends are in the key's own workspace (composite keys), and deleting the key or the team deletes the row.
 */
export const apiKeyTeams = table(
  "api_key_teams",
  {
    apiKeyId: uuid("api_key_id").notNull(),
    teamId: uuid("team_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.apiKeyId, t.teamId] }),
    teamScope("api_key_teams", t),
    foreignKey({ name: "api_key_teams_key_fk", columns: [t.apiKeyId, t.workspaceId], foreignColumns: [apiKeys.id, apiKeys.workspaceId] }).onDelete("cascade"),
    index("api_key_teams_team_idx").on(t.teamId),
  ],
);

/** Capability flags a key can be granted. Currently just docs write access (WH-51). */
export const KEY_CAPABILITIES = ["docs:write"] as const;
export type KeyCapability = (typeof KEY_CAPABILITIES)[number];

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
  createdAt: createdAt(),
}, (t) => [
  unique("teams_id_workspace_id_unique").on(t.id, t.workspaceId),
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
  // What stage of work this status stands for (WH-86); rules and reports use it, never the name. Null: a custom status.
  role: text("role", { enum: STATUS_ROLES }),
  isDefault: boolean("is_default").notNull().default(false),
}, (t) => [
  teamScope("statuses", t),
  uniqueIndex("statuses_team_default_role_idx").on(t.teamId, t.role).where(sql`is_default`),
  uniqueIndex("statuses_team_name_idx").on(t.teamId, sql`lower(${t.name})`),
  check("statuses_default_has_role_check", sql`not "is_default" or "role" is not null`),
]);

export const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;

export const issues = table(
  "issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    statusId: uuid("status_id").notNull().references(() => statuses.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    priority: text("priority", { enum: PRIORITIES }).notNull().default("none"),
    // Only a member of the issue's team can be assigned. The foreign key `(team_id, assignee_id)` to team_members
    // is `ON DELETE SET NULL (assignee_id)` (migration 0020; drizzle cannot express the column list), so leaving the
    // team unassigns the person's issues without touching team_id.
    assigneeId: uuid("assignee_id"),
    // The cycle the issue is in, of its own team: the foreign key `(cycle_id, team_id)` to cycles is `ON DELETE SET NULL (cycle_id)`
    // (migration 0023; drizzle cannot express the column list), so deleting a cycle takes its issues out without touching team_id.
    cycleId: uuid("cycle_id"),
    // The project (a deliverable that can span teams) and its milestone. Keys in migration 0024, written there because drizzle
    // cannot say SET NULL on named columns: `(project_id, team_id)` to project_teams, so only a team that takes part may put a
    // issue in the project (removing the team takes both columns out), and `(milestone_id, project_id)` to its milestones.
    projectId: uuid("project_id"),
    milestoneId: uuid("milestone_id"),
    // The issue this one is a sub-issue of, in its own team: the foreign key `(parent_id, team_id)` to issues is
    // `ON DELETE SET NULL (parent_id)` (migration 0031), so deleting a parent frees its sub-issues and leaves them in their team.
    // The service refuses a parent that would make a loop (an issue under its own descendant); see `setParent`.
    parentId: uuid("parent_id"),
    agentClaimable: boolean("agent_claimable").notNull().default(false),
    claimedByKeyId: uuid("claimed_by_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    position: doublePrecision("position").notNull(),
    version: integer("version").notNull().default(1),
    createdByKind: text("created_by_kind", { enum: ["human", "agent"] }).notNull(),
    createdById: uuid("created_by_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    teamScope("issues", t),
    unique("issues_id_team_unique").on(t.id, t.teamId),
    index("issues_team_idx").on(t.teamId),
    index("issues_cycle_idx").on(t.cycleId),
    index("issues_project_idx").on(t.projectId),
    index("issues_milestone_idx").on(t.milestoneId),
    index("issues_parent_idx").on(t.parentId),
    check("issues_not_own_parent_check", sql`"parent_id" is distinct from "id"`),
    check("issues_milestone_needs_project_check", sql`"milestone_id" is null or "project_id" is not null`),
    uniqueIndex("issues_team_number_idx").on(t.teamId, t.number),
  ],
);

/**
 * A team's cycles (WH-117, ADR-11 revised: cycles belong to a team): an optional 1 to 14 day window with a goal. Numbered
 * per team, never overlapping inside a team (the service checks that, under a lock on the team: an exclusion constraint needs an
 * extension that PGlite does not load). Unfinished issues move to the next cycle once the window has ended; `rolled_over_at` is
 * what makes that happen exactly once.
 */
export const cycles = table(
  "cycles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    number: integer("number").notNull(),
    name: text("name").notNull().default(""),
    goal: text("goal").notNull().default(""),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    rolledOverAt: timestamp("rolled_over_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    teamScope("cycles", t),
    unique("cycles_id_team_unique").on(t.id, t.teamId),
    uniqueIndex("cycles_team_number_idx").on(t.teamId, t.number),
    index("cycles_team_starts_idx").on(t.teamId, t.startsAt),
    check("cycles_window_check", sql`"ends_at" > "starts_at"`),
  ],
);

export const PROJECT_STATUSES = ["planned", "active", "paused", "completed", "canceled"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const PROJECT_HEALTH = ["on_track", "at_risk", "off_track"] as const;
export type ProjectHealth = (typeof PROJECT_HEALTH)[number];

/**
 * A project (WH-118): an outcome that ends and can span teams, with a lead, dates, milestones and a health that is worked out from
 * its issues and dates unless someone sets it. It belongs to the workspace; the teams that take part are in `project_teams`, and
 * its lead team is one of them: the key `(lead_team_id, id)` into project_teams is deferrable (migration 0024), so a project and its
 * first team are made in one transaction. Deleting is soft (`deleted_at`).
 */
export const projects = table(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    // A member of the workspace; leaving the workspace clears it (the key is in migration 0024: SET NULL on one column).
    leadUserId: uuid("lead_user_id"),
    leadTeamId: uuid("lead_team_id").notNull(),
    status: text("status", { enum: PROJECT_STATUSES }).notNull().default("planned"),
    startDate: date("start_date", { mode: "string" }),
    targetDate: date("target_date", { mode: "string" }),
    healthOverride: text("health_override", { enum: PROJECT_HEALTH }),
    version: integer("version").notNull().default(1),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("projects_id_workspace_id_unique").on(t.id, t.workspaceId),
    index("projects_workspace_idx").on(t.workspaceId, t.status),
    check("projects_dates_check", sql`"start_date" is null or "target_date" is null or "target_date" >= "start_date"`),
  ],
);

/** The teams that take part in a project. An issue can be in the project only through its own team's row here. */
export const projectTeams = table(
  "project_teams",
  {
    projectId: uuid("project_id").notNull(),
    teamId: uuid("team_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.teamId] }),
    teamScope("project_teams", t),
    foreignKey({ name: "project_teams_project_fk", columns: [t.projectId, t.workspaceId], foreignColumns: [projects.id, projects.workspaceId] }).onDelete("cascade"),
    index("project_teams_team_idx").on(t.teamId),
  ],
);

/** Ordered stages of a project, each with an optional target date. An issue may be in one. */
export const projectMilestones = table(
  "project_milestones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    targetDate: date("target_date", { mode: "string" }),
    position: doublePrecision("position").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("project_milestones_id_project_unique").on(t.id, t.projectId),
    foreignKey({ name: "project_milestones_project_fk", columns: [t.projectId, t.workspaceId], foreignColumns: [projects.id, projects.workspaceId] }).onDelete("cascade"),
    index("project_milestones_project_idx").on(t.projectId, t.position),
  ],
);

/**
 * Who can see which project: a person who is on a team that takes part, and is not a guest of the workspace (WH-118, plan section 5).
 * The service lists projects through this; opening one also needs the caller's team role. Created in migration 0024.
 */
export const projectVisibility = pgView("project_visibility", {
  userId: uuid("user_id").notNull(),
  projectId: uuid("project_id").notNull(),
}).existing();

export const comments = table("comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  authorKind: text("author_kind", { enum: ["human", "agent"] }).notNull(),
  authorId: uuid("author_id"),
  authorName: text("author_name").notNull(),
  body: text("body").notNull(),
  createdAt: createdAt(),
});

// Three zoom levels of one linked model:
//   concept — what the product does / its ideas (logical view)
//   system  — what runs where and talks to what (architecture)
//   data    — what's stored and how it relates (tables, views, enums)
//   code    — where it lives (files, symbols, endpoints)
export const LAYERS = ["concept", "system", "data", "code"] as const;
export type Layer = (typeof LAYERS)[number];

export const KINDS_BY_LAYER = {
  concept: ["concept", "capability", "actor"],
  system: ["service", "module", "component", "database", "queue", "external"],
  data: ["table", "view", "enum"],
  code: ["directory", "file", "symbol", "endpoint"],
} as const satisfies Record<Layer, readonly string[]>;

export const NODE_KINDS = [...KINDS_BY_LAYER.concept, ...KINDS_BY_LAYER.system, ...KINDS_BY_LAYER.data, ...KINDS_BY_LAYER.code] as const;
export const EDGE_KINDS = ["depends", "implements", "references"] as const;

/** A column of a data-layer table/view (for enums: one entry per value, `type` unused). */
export type Column = {
  name: string;
  type: string;
  nullable?: boolean;
  pk?: boolean;
  unique?: boolean;
  default?: string;
  references?: string; // "table.column" foreign key target
  onDelete?: string; // cascade | set null | restrict …
  note?: string;
};
export type Index = { name?: string; columns: string[]; unique?: boolean };
export const CARDINALITIES = ["1-1", "n-1", "1-n", "n-m"] as const;
export type EdgeMeta = { fromColumn?: string; toColumn?: string; cardinality?: (typeof CARDINALITIES)[number]; onDelete?: string; derived?: boolean };

export const nodes = table("nodes", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  parentId: uuid("parent_id"),
  layer: text("layer", { enum: LAYERS }).notNull().default("system"),
  kind: text("kind", { enum: NODE_KINDS }).notNull().default("service"),
  name: text("name").notNull(),
  summary: text("summary").notNull().default(""),
  // Structured explainer (markdown each) so agent-written content stays consistent.
  purpose: text("purpose").notNull().default(""),
  responsibilities: text("responsibilities").notNull().default(""),
  interfaces: text("interfaces").notNull().default(""),
  gotchas: text("gotchas").notNull().default(""),
  details: text("details").notNull().default(""), // free-form notes
  // Freshness: file paths/globs this node describes, and the commit it was last described at.
  anchors: jsonb("anchors").$type<string[]>().notNull().default([]),
  // Data layer only: table/view columns (or enum values) and indexes.
  columns: jsonb("columns").$type<Column[]>().notNull().default([]),
  indexes: jsonb("indexes").$type<Index[]>().notNull().default([]),
  describedSha: text("described_sha"),
  describedAt: timestamp("described_at", { withTimezone: true }),
  stale: boolean("stale").notNull().default(false),
  staleReason: text("stale_reason"),
  // "report": flagged by a file-list report (cleared by re-describing / mark_fresh).
  // "drift": landed content hashes differ from describedHashes (also clears itself on revert).
  staleSource: text("stale_source", { enum: ["report", "drift"] }),
  // Content hashes of anchored files at the time the explanation was written, and landed paths that now differ.
  describedHashes: jsonb("described_hashes").$type<Record<string, string>>().notNull().default({}),
  driftPaths: jsonb("drift_paths").$type<string[]>().notNull().default([]),
  status: text("status", { enum: ["planned", "building", "live", "deprecated"] }).notNull().default("planned"),
  x: doublePrecision("x").notNull().default(0),
  y: doublePrecision("y").notNull().default(0),
  width: doublePrecision("width"),
  height: doublePrecision("height"),
  // True once a person has explicitly positioned/resized this node (drag, resize, or an
  // explicit x/y in an upsert) — distinguishes that from the server's fixed-grid auto-placement
  // at creation time, so a bulk "Tidy" run knows what it's safe to rearrange (WH-21).
  placed: boolean("placed").notNull().default(false),
  version: integer("version").notNull().default(1),
  updatedAt: updatedAt(),
}, (t) => [
  teamScope("nodes", t),
  // The parent is a node of the same team; deleting it removes the nested ones (the service already does).
  unique("nodes_id_team_unique").on(t.id, t.teamId),
  foreignKey({ name: "nodes_parent_fk", columns: [t.parentId, t.teamId], foreignColumns: [t.id, t.teamId] }).onDelete("cascade"),
]);

export const edges = table("edges", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  fromNodeId: uuid("from_node_id").notNull().references(() => nodes.id, { onDelete: "cascade" }),
  toNodeId: uuid("to_node_id").notNull().references(() => nodes.id, { onDelete: "cascade" }),
  // depends: from uses/calls to (same layer). implements: from (lower layer) realizes to (higher layer).
  kind: text("kind", { enum: EDGE_KINDS }).notNull().default("depends"),
  label: text("label").notNull().default(""),
  // references edges: column-level FK detail + cardinality.
  meta: jsonb("meta").$type<EdgeMeta>().notNull().default({}),
}, (t) => [teamScope("edges", t)]);

export type FlowStep = { nodeId: string; title: string; detail: string };

/** A named, ordered walk across nodes that explains how something works end to end. */
export const flows = table("flows", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  steps: jsonb("steps").$type<FlowStep[]>().notNull().default([]),
  version: integer("version").notNull().default(1),
  updatedAt: updatedAt(),
}, (t) => [teamScope("flows", t)]);

export const DECISION_STATUSES = ["proposed", "accepted", "superseded", "rejected"] as const;

/** Lightweight ADRs: the "why" behind non-obvious choices, attached to nodes. */
export const decisions = table(
  "decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    status: text("status", { enum: DECISION_STATUSES }).notNull().default("accepted"),
    context: text("context").notNull().default(""),
    decision: text("decision").notNull().default(""),
    consequences: text("consequences").notNull().default(""),
    authorKind: text("author_kind", { enum: ["human", "agent"] }).notNull(),
    authorName: text("author_name").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [teamScope("decisions", t), unique("decisions_id_team_unique").on(t.id, t.teamId), uniqueIndex("decisions_team_number_idx").on(t.teamId, t.number)],
);

/** The nodes an ADR applies to, inside one team. */
export const decisionNodes = table(
  "decision_nodes",
  {
    decisionId: uuid("decision_id").notNull(),
    nodeId: uuid("node_id").notNull(),
    teamId: uuid("team_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.decisionId, t.nodeId] }),
    teamScope("decision_nodes", t),
    foreignKey({ name: "decision_nodes_decision_fk", columns: [t.decisionId, t.teamId], foreignColumns: [decisions.id, decisions.teamId] }).onDelete("cascade"),
    foreignKey({ name: "decision_nodes_node_fk", columns: [t.nodeId, t.teamId], foreignColumns: [nodes.id, nodes.teamId] }).onDelete("cascade"),
    index("decision_nodes_node_idx").on(t.nodeId),
  ],
);

/** A team's labels: one row per name (any case), so a label can be filtered, renamed or deleted in one place. */
export const labels = table(
  "labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    name: text("name").notNull(),
    color: text("color"),
    createdAt: createdAt(),
  },
  (t) => [
    teamScope("labels", t),
    unique("labels_id_team_unique").on(t.id, t.teamId),
    uniqueIndex("labels_team_name_idx").on(t.teamId, sql`lower(${t.name})`),
  ],
);

/** The labels on an issue (the issue and the label are of the same team). Deleting either removes the row. */
export const issueLabels = table(
  "issue_labels",
  {
    issueId: uuid("issue_id").notNull(),
    labelId: uuid("label_id").notNull(),
    teamId: uuid("team_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.issueId, t.labelId] }),
    teamScope("issue_labels", t),
    foreignKey({ name: "issue_labels_issue_fk", columns: [t.issueId, t.teamId], foreignColumns: [issues.id, issues.teamId] }).onDelete("cascade"),
    foreignKey({ name: "issue_labels_label_fk", columns: [t.labelId, t.teamId], foreignColumns: [labels.id, labels.teamId] }).onDelete("cascade"),
    index("issue_labels_label_idx").on(t.labelId),
  ],
);

/** Domain glossary; terms get hover cards wherever they appear in explainers. */
export const terms = table(
  "terms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    term: text("term").notNull(),
    definition: text("definition").notNull(),
    nodeId: uuid("node_id").references(() => nodes.id, { onDelete: "set null" }),
    updatedAt: updatedAt(),
  },
  (t) => [teamScope("terms", t), uniqueIndex("terms_team_term_idx").on(t.teamId, t.term)],
);

export const issueNodes = table(
  "issue_nodes",
  {
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    nodeId: uuid("node_id").notNull().references(() => nodes.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.issueId, t.nodeId] })],
);

// Append-only change log. Powers the activity feed and the AI queue.
export const events = table(
  "events",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    teamId: uuid("team_id").notNull(),
    actorKind: text("actor_kind", { enum: ["human", "agent"] }).notNull(),
    actorId: uuid("actor_id"),
    actorName: text("actor_name").notNull(),
    type: text("type").notNull(), // e.g. issue.created, issue.moved, comment.created
    entity: text("entity", { enum: ["issue", "comment", "node", "edge", "status", "team", "flow", "decision", "term", "doc", "cycle", "project"] }).notNull(),
    entityId: uuid("entity_id").notNull(),
    summary: text("summary").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    // Client session that made the change (Claude Code session_id), when known. Lets sessions
    // sharing one API key see each other's writes. No FK: sessions are pruned, events never are.
    sessionId: text("session_id"),
    createdAt: createdAt(),
  },
  (t) => [index("events_team_seq_idx").on(t.teamId, t.seq)],
);

// Per-agent read pointer into `events` (the AI queue).
export const WORKSPACE_EVENT_ENTITIES = ["project", "initiative"] as const;

export const INITIATIVE_STATUSES = ["planned", "active", "paused", "done"] as const;
export type InitiativeStatus = (typeof INITIATIVE_STATUSES)[number];
/** How deep initiatives may nest (a soft limit, kept by the service). */
export const INITIATIVE_MAX_DEPTH = 3;

/**
 * Initiatives (WH-119): a goal that groups projects, and other initiatives under it up to three levels. An initiative belongs to
 * the workspace, not to a team. It holds no issues and no teams: its progress is rolled up from the issues of its projects and
 * of its sub-initiatives. Deleting is soft (`deleted_at`) and never touches the projects.
 */
export const initiatives = table(
  "initiatives",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    // A member of the workspace; leaving the workspace clears it (the key is in migration 0025: SET NULL on one column).
    ownerId: uuid("owner_id"),
    status: text("status", { enum: INITIATIVE_STATUSES }).notNull().default("planned"),
    targetDate: date("target_date", { mode: "string" }),
    healthOverride: text("health_override", { enum: PROJECT_HEALTH }),
    position: doublePrecision("position").notNull().default(0),
    version: integer("version").notNull().default(1),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("initiatives_id_workspace_id_unique").on(t.id, t.workspaceId),
    foreignKey({ name: "initiatives_parent_fk", columns: [t.parentId, t.workspaceId], foreignColumns: [t.id, t.workspaceId] }),
    check("initiatives_not_own_parent_check", sql`"parent_id" is null or "parent_id" <> "id"`),
    index("initiatives_workspace_idx").on(t.workspaceId, t.parentId),
  ],
);

/** The projects an initiative groups. A project can be in several initiatives; an issue is still counted once in a roll-up. */
export const initiativeProjects = table(
  "initiative_projects",
  {
    initiativeId: uuid("initiative_id").notNull(),
    projectId: uuid("project_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.initiativeId, t.projectId] }),
    foreignKey({ name: "initiative_projects_initiative_fk", columns: [t.initiativeId, t.workspaceId], foreignColumns: [initiatives.id, initiatives.workspaceId] }).onDelete("cascade"),
    foreignKey({ name: "initiative_projects_project_fk", columns: [t.projectId, t.workspaceId], foreignColumns: [projects.id, projects.workspaceId] }).onDelete("cascade"),
    index("initiative_projects_project_idx").on(t.projectId),
  ],
);

/**
 * The append-only change log of what belongs to the workspace and not to one team: projects and, with WH-119, initiatives. Same
 * shape as `events` without a team. A change that matters to a team (an issue joins a project, a milestone moves) is also written to
 * that team's `events`, which is what the team's agents read. Never updated or deleted.
 */
export const workspaceEvents = table(
  "workspace_events",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    actorKind: text("actor_kind", { enum: ["human", "agent"] }).notNull(),
    actorId: uuid("actor_id"),
    actorName: text("actor_name").notNull(),
    type: text("type").notNull(), // e.g. project.created, project.team_added, project.milestone_changed
    entity: text("entity", { enum: WORKSPACE_EVENT_ENTITIES }).notNull(),
    entityId: uuid("entity_id").notNull(),
    summary: text("summary").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("workspace_events_workspace_seq_idx").on(t.workspaceId, t.seq)],
);

export const agentCursors = table(
  "agent_cursors",
  {
    apiKeyId: uuid("api_key_id").notNull().references(() => apiKeys.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    lastSeq: bigint("last_seq", { mode: "number" }).notNull().default(0),
  },
  (t) => [teamScope("agent_cursors", t), primaryKey({ columns: [t.apiKeyId, t.teamId] })],
);

/** Server's view of the default branch: content hash per file, updated when code lands. */
export const REPO_PROVIDERS = ["github", "local"] as const;
export const REPO_LIFECYCLES = ["live", "being_replaced", "planned", "retired"] as const;

/**
 * Multiple repositories per team (ADR-7, WH-68): a team can be served by
 * several repos (frontend/backend/admin…) or share a monorepo with other
 * teams. Each team<->repo link is its own row (so the same physical repo
 * connected to two teams is two rows, each with its own `pathLimit`), which
 * avoids a many-to-many join table and matches "each team's link to it
 * carries its own path limit" in the issue. `slug` is the natural
 * identifying key the CLI/wheelhouse.json reports for `provider: "local"`
 * (or the GitHub repo id once connected), used to find-or-create the right
 * row per team on each report.
 */
export const repositories = table(
  "repositories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    displayName: text("display_name").notNull(),
    role: text("role").notNull(), // free text: workspaces name their own roles (frontend/backend/admin/…)
    provider: text("provider", { enum: REPO_PROVIDERS }).notNull().default("local"),
    // Natural identifying key for "same physical repo": the slug/name the CLI reports (provider=local),
    // or the stringified GitHub repo id once connected (provider=github). Unique per team so
    // find-or-create resolves to exactly one row.
    slug: text("slug").notNull(),
    githubRepoId: text("github_repo_id"),
    githubInstallationId: text("github_installation_id"),
    githubFullName: text("github_full_name"), // "owner/name", for display; the id is what identifies the repository
    defaultBranch: text("default_branch").notNull().default("main"),
    // A monorepo directory this team's link is limited to, e.g. "packages/billing/". Null = whole repo.
    pathLimit: text("path_limit"),
    lifecycle: text("lifecycle", { enum: REPO_LIFECYCLES }).notNull().default("live"),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [teamScope("repositories", t), index("repositories_team_idx").on(t.teamId), uniqueIndex("repositories_team_slug_idx").on(t.teamId, t.slug)],
);

export const teamFiles = table(
  "team_files",
  {
    teamId: uuid("team_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    path: text("path").notNull(),
    hash: text("hash").notNull(),
    sha: text("sha"),
    // Which repository this file belongs to (WH-68). Null for existing single-repo rows written before this
    // change, or when the client doesn't report a repository — treated as "unqualified / matches everything".
    repositoryId: uuid("repository_id").references(() => repositories.id, { onDelete: "cascade" }),
    updatedAt: updatedAt(),
  },
  (t) => [teamScope("team_files", t), primaryKey({ columns: [t.teamId, t.path] })],
);

export type SessionFile = { hash: string | null; at: string; external?: boolean; repositoryId?: string | null }; // external: changed outside the agent (e.g. a human in the IDE)

/**
 * A client session (e.g. one Claude Code session) working in a team: which
 * files it has changed but not landed, which issue it's on, when it last
 * checked in. Drives "in flux" on the map and the reconciliation check.
 */
export const workSessions = table(
  "work_sessions",
  {
    id: text("id").primaryKey(), // client-provided session id (Claude Code session_id)
    teamId: uuid("team_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    actorName: text("actor_name").notNull(),
    client: text("client").notNull().default("unknown"),
    branch: text("branch"),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    files: jsonb("files").$type<Record<string, SessionFile>>().notNull().default({}),
    // This session's own read pointer into `events` (its AI queue). Null until the session first reads it.
    lastSeq: bigint("last_seq", { mode: "number" }),
    // Soft delete: a teammate removed this session. Kept (30 days) so a reconnect can be detected.
    removedAt: timestamp("removed_at", { withTimezone: true }),
    // Set on reconnect after removal until the agent chooses replay/skip: where its cursor was, and when it was removed.
    resumeFromSeq: bigint("resume_from_seq", { mode: "number" }),
    resumeRemovedAt: timestamp("resume_removed_at", { withTimezone: true }),
    firstChangeAt: timestamp("first_change_at", { withTimezone: true }),
    startedAt: createdAt(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [teamScope("work_sessions", t), index("work_sessions_team_idx").on(t.teamId)],
);

/**
 * A map update written against code that hasn't landed yet. Published when the
 * code lands on the default branch, discarded if the work is abandoned.
 */
export const nodeDrafts = table(
  "node_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    nodeId: uuid("node_id").notNull().references(() => nodes.id, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => workSessions.id, { onDelete: "set null" }),
    authorName: text("author_name").notNull(),
    authorKind: text("author_kind", { enum: ["human", "agent"] }).notNull(),
    // Explainer/column fields to apply on publish; {} with confirm=true means "still accurate".
    patch: jsonb("patch").$type<Record<string, unknown>>().notNull().default({}),
    confirm: boolean("confirm").notNull().default(false),
    status: text("status", { enum: ["pending", "published", "discarded"] }).notNull().default("pending"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [teamScope("node_drafts", t), index("node_drafts_node_idx").on(t.nodeId)],
);

// ───────── GitHub App (WH-20) ─────────

// Which workspace an installation of the App belongs to. A row exists only after the installing person proved, through
// GitHub's own sign-in, that they administer that installation: an installation id alone is a public number.
export const githubInstallations = table("github_installations", {
  installationId: text("installation_id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  accountLogin: text("account_login").notNull().default(""),
  accountType: text("account_type").notNull().default(""),
  connectedBy: uuid("connected_by"), // the user who connected it; no FK, people can leave
  createdAt: createdAt(),
});

// Deliveries we have already handled (GitHub retries), so a redelivery changes nothing.
export const githubDeliveries = table("github_deliveries", {
  id: text("id").primaryKey(), // X-GitHub-Delivery
  event: text("event").notNull(),
  receivedAt: createdAt(),
});

// A pull request seen on a connected repository, with the state of its checks.
export const pullRequests = table(
  "pull_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    author: text("author").notNull().default(""),
    headBranch: text("head_branch").notNull().default(""),
    headSha: text("head_sha").notNull().default(""),
    state: text("state", { enum: ["open", "closed", "merged"] }).notNull().default("open"),
    draft: boolean("draft").notNull().default(false),
    // The latest result per check name for headSha; cleared when a new commit arrives.
    checks: jsonb("checks").$type<Record<string, { status: string; conclusion: string | null; url?: string | null }>>().notNull().default({}),
    ciState: text("ci_state", { enum: ["success", "failure", "pending"] }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("pull_requests_repo_number_idx").on(t.repositoryId, t.number)],
);

export const pullRequestIssues = table(
  "pull_request_issues",
  {
    pullRequestId: uuid("pull_request_id").notNull().references(() => pullRequests.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.pullRequestId, t.issueId] }), index("pull_request_issues_issue_idx").on(t.issueId)],
);

// ───────── workspace documentation (WH-51) ─────────
//
// Markdown docs that live in Wheelhouse next to the board and map: runbooks,
// product notes, conventions, decisions in prose. A tree (parentId), optimistic
// locking like issues, soft delete with a 30-day purge. Agents read them over
// MCP/REST; writing requires a key with the "docs:write" capability or a human.

export const docs = table(
  "docs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    parentId: uuid("parent_id"),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""), // markdown, <= 200KB (enforced in service.ts)
    version: integer("version").notNull().default(1),
    position: doublePrecision("position").notNull().default(0),
    createdByKind: text("created_by_kind", { enum: ["human", "agent"] }).notNull(),
    createdById: uuid("created_by_id"),
    updatedByKind: text("updated_by_kind", { enum: ["human", "agent"] }).notNull(),
    updatedById: uuid("updated_by_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // Soft delete: kept 30 days so a purge job (or a human) can still recover it; history also lives in `events`.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    // ───── freshness (WH-64): mirrors the same columns on `nodes` exactly ─────
    // File paths/globs this doc is anchored to (author-confirmed; suggested anchors are never auto-applied).
    anchors: jsonb("anchors").$type<string[]>().notNull().default([]),
    describedSha: text("described_sha"),
    describedAt: timestamp("described_at", { withTimezone: true }),
    stale: boolean("stale").notNull().default(false),
    staleReason: text("stale_reason"),
    // "report": flagged by a file-list report (cleared by editing the body / mark_doc_fresh).
    // "drift": landed content hashes differ from describedHashes (also clears itself on revert).
    staleSource: text("stale_source", { enum: ["report", "drift"] }),
    // Content hashes of anchored files when the doc was last confirmed accurate, and landed paths that now differ.
    describedHashes: jsonb("described_hashes").$type<Record<string, string>>().notNull().default({}),
    driftPaths: jsonb("drift_paths").$type<string[]>().notNull().default([]),
    // Free-text tags (WH-103), like issues.labels. Not part of the freshness rules: tagging a doc never marks it fresh.
    labels: jsonb("labels").$type<string[]>().notNull().default([]),
  },
  (t) => [
    teamScope("docs", t),
    // The parent is a doc of the same team.
    unique("docs_id_team_unique").on(t.id, t.teamId),
    foreignKey({ name: "docs_parent_fk", columns: [t.parentId, t.teamId], foreignColumns: [t.id, t.teamId] }).onDelete("cascade"),
    index("docs_team_idx").on(t.teamId),
    // Unique per (team, parent, slug) among live docs. Partial index: deleted docs don't block reusing a slug.
    uniqueIndex("docs_team_parent_slug_idx").on(t.teamId, t.parentId, t.slug).where(sql`deleted_at is null`),
  ],
);

/**
 * A doc edit written against code that hasn't landed yet (WH-64). Mirrors `nodeDrafts`
 * exactly (same patch/confirm/status shape): published when the anchored code lands,
 * discarded if the work is abandoned. Kept as its own table (not a generalized
 * drafts table) because `nodeDrafts` isn't generic today — it's keyed on `nodeId`
 * with node-specific publish logic in sync.ts, and doc publish logic (patch fields
 * are title/body, not explainer/column fields) differs enough that sharing one
 * table would need a polymorphic entityId/kind column for no real gain at this scale.
 */
export const docDrafts = table(
  "doc_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    docId: uuid("doc_id").notNull().references(() => docs.id, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => workSessions.id, { onDelete: "set null" }),
    authorName: text("author_name").notNull(),
    authorKind: text("author_kind", { enum: ["human", "agent"] }).notNull(),
    // title/body to apply on publish; {} with confirm=true means "still accurate".
    patch: jsonb("patch").$type<Record<string, unknown>>().notNull().default({}),
    confirm: boolean("confirm").notNull().default(false),
    status: text("status", { enum: ["pending", "published", "discarded"] }).notNull().default("pending"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [teamScope("doc_drafts", t), index("doc_drafts_doc_idx").on(t.docId)],
);

/** Links a doc to a map node, mirroring issue_nodes, so a node's page can list "read these docs". */
export const docNodes = table(
  "doc_nodes",
  {
    docId: uuid("doc_id").notNull().references(() => docs.id, { onDelete: "cascade" }),
    nodeId: uuid("node_id").notNull().references(() => nodes.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.docId, t.nodeId] })],
);
