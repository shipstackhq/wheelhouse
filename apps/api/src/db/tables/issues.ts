import { uuid, text, timestamp, integer, boolean, primaryKey, doublePrecision, index, uniqueIndex, unique, foreignKey, check, date, pgView } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { table, createdAt, updatedAt } from "./common";
import { teamScope } from "./team-scope";
import { workspaces, apiKeys } from "./auth";
import { nodes } from "./map";
import { statuses } from "./teams";

export const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;

export type Priority = (typeof PRIORITIES)[number];

export const issues = table(
  "issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    // No action, not cascade: a status that still has issues cannot be deleted by accident (the service moves them first). A team's
    // deletion removes both in one statement, which this allows.
    statusId: uuid("status_id").notNull().references(() => statuses.id, { onDelete: "no action" }),
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
    // The same five levels as an issue's, "none" until someone says.
    priority: text("priority", { enum: PRIORITIES }).notNull().default("none"),
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

export const issueNodes = table(
  "issue_nodes",
  {
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    nodeId: uuid("node_id").notNull().references(() => nodes.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.issueId, t.nodeId] })],
);

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
