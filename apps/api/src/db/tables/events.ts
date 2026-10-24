import { uuid, text, jsonb, bigserial, bigint, primaryKey, index } from "drizzle-orm/pg-core";
import { table, createdAt } from "./common";
import { teamScope } from "./team-scope";
import { workspaces, apiKeys } from "./auth";

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
