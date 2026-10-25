import { sql } from "drizzle-orm";
import { uuid, text, jsonb, integer, timestamp, primaryKey, unique, uniqueIndex, foreignKey, check } from "drizzle-orm/pg-core";
import type { AgentProfile } from "@wheelhouse/shared/agents/schema";
import { table, createdAt } from "./common";
import { teamScope } from "./team-scope";
import { users, workspaces } from "./auth";

export const AGENT_SOURCES = ["catalog", "custom"] as const;

/**
 * An agent of a workspace. `custom`: the workspace's own, the full profile is stored. `catalog`: a Wheelhouse agent, no profile, just
 * which version the workspace pinned (null follows the latest); its row appears the first time it is added to a team or pinned.
 * `team_id` null: any team may add it; set: a team's own agent, only that team.
 */
export const workspaceAgents = table(
  "workspace_agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    teamId: uuid("team_id"),
    slug: text("slug").notNull(),
    source: text("source", { enum: AGENT_SOURCES }).notNull(),
    catalogSlug: text("catalog_slug"),
    pinnedVersion: integer("pinned_version"),
    profile: jsonb("profile").$type<AgentProfile>(),
    version: integer("version").notNull().default(1),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    teamScope("workspace_agents", t),
    uniqueIndex("workspace_agents_slug_idx").on(t.workspaceId, t.slug),
    unique("workspace_agents_id_workspace_unique").on(t.id, t.workspaceId),
    check("workspace_agents_shape", sql`(${t.source} = 'custom' and ${t.profile} is not null) or (${t.source} = 'catalog' and ${t.catalogSlug} is not null and ${t.profile} is null and ${t.teamId} is null)`),
  ],
);

/** A team's roster: a reference to a workspace agent, so the team sees edits and catalog updates. */
export const teamAgents = table(
  "team_agents",
  {
    teamId: uuid("team_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    workspaceAgentId: uuid("workspace_agent_id").notNull(),
    addedBy: uuid("added_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.workspaceAgentId] }),
    teamScope("team_agents", t),
    foreignKey({ name: "team_agents_agent_fk", columns: [t.workspaceAgentId, t.workspaceId], foreignColumns: [workspaceAgents.id, workspaceAgents.workspaceId] }).onDelete("cascade"),
  ],
);
