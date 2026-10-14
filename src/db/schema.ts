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
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: createdAt(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(), // sha256 of the cookie token
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const teams = pgTable("teams", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: createdAt(),
  // Instance-admin suspension (WH-52): a suspended team's members cannot sign in and its API keys are refused.
  // Reversible: nothing is deleted, restoring clears these three columns.
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  suspendedBy: uuid("suspended_by").references(() => users.id, { onDelete: "set null" }),
  suspendedReason: text("suspended_reason"),
});

export const memberships = pgTable(
  "memberships",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "member"] }).notNull().default("member"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.teamId] })],
);

// Invite-only signup (WH-49). Only the SHA-256 of the token is stored; the plain token is shown once.
// kind new_team: the invitee gets a fresh team and owns it. kind join_team: the invitee joins team_id.
export const invites = pgTable(
  "invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind", { enum: ["new_team", "join_team"] }).notNull(),
    email: text("email").notNull(), // lower-cased; the account is created with exactly this address
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }), // join_team only
    teamName: text("team_name"), // new_team only (optional)
    role: text("role", { enum: ["owner", "member"] }).notNull().default("member"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    tokenHash: text("token_hash").notNull().unique(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    usedBy: uuid("used_by").references(() => users.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("invites_team_idx").on(t.teamId, t.usedAt)],
);

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(), // first chars, shown in UI
  keyHash: text("key_hash").notNull().unique(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  key: text("key").notNull(), // short prefix like "WH" for ticket refs
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  ticketCounter: integer("ticket_counter").notNull().default(0),
  createdAt: createdAt(),
});

export const columns = pgTable("columns", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  position: doublePrecision("position").notNull(),
});

export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;

export const tickets = pgTable(
  "tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    columnId: uuid("column_id").notNull().references(() => columns.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    priority: text("priority", { enum: PRIORITIES }).notNull().default("medium"),
    assigneeId: uuid("assignee_id").references(() => users.id, { onDelete: "set null" }),
    agentClaimable: boolean("agent_claimable").notNull().default(false),
    claimedByKeyId: uuid("claimed_by_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    labels: jsonb("labels").$type<string[]>().notNull().default([]),
    position: doublePrecision("position").notNull(),
    version: integer("version").notNull().default(1),
    createdByKind: text("created_by_kind", { enum: ["human", "agent"] }).notNull(),
    createdById: uuid("created_by_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("tickets_project_idx").on(t.projectId),
    uniqueIndex("tickets_project_number_idx").on(t.projectId, t.number),
  ],
);

export const comments = pgTable("comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  ticketId: uuid("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
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

export const nodes = pgTable("nodes", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
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
  version: integer("version").notNull().default(1),
  updatedAt: updatedAt(),
});

export const edges = pgTable("edges", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  fromNodeId: uuid("from_node_id").notNull().references(() => nodes.id, { onDelete: "cascade" }),
  toNodeId: uuid("to_node_id").notNull().references(() => nodes.id, { onDelete: "cascade" }),
  // depends: from uses/calls to (same layer). implements: from (lower layer) realizes to (higher layer).
  kind: text("kind", { enum: EDGE_KINDS }).notNull().default("depends"),
  label: text("label").notNull().default(""),
  // references edges: column-level FK detail + cardinality.
  meta: jsonb("meta").$type<EdgeMeta>().notNull().default({}),
});

export type FlowStep = { nodeId: string; title: string; detail: string };

/** A named, ordered walk across nodes that explains how something works end to end. */
export const flows = pgTable("flows", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  steps: jsonb("steps").$type<FlowStep[]>().notNull().default([]),
  version: integer("version").notNull().default(1),
  updatedAt: updatedAt(),
});

export const DECISION_STATUSES = ["proposed", "accepted", "superseded", "rejected"] as const;

/** Lightweight ADRs: the "why" behind non-obvious choices, attached to nodes. */
export const decisions = pgTable(
  "decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    status: text("status", { enum: DECISION_STATUSES }).notNull().default("accepted"),
    context: text("context").notNull().default(""),
    decision: text("decision").notNull().default(""),
    consequences: text("consequences").notNull().default(""),
    nodeIds: jsonb("node_ids").$type<string[]>().notNull().default([]),
    authorKind: text("author_kind", { enum: ["human", "agent"] }).notNull(),
    authorName: text("author_name").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("decisions_project_number_idx").on(t.projectId, t.number)],
);

/** Domain glossary; terms get hover cards wherever they appear in explainers. */
export const terms = pgTable(
  "terms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    term: text("term").notNull(),
    definition: text("definition").notNull(),
    nodeId: uuid("node_id").references(() => nodes.id, { onDelete: "set null" }),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("terms_project_term_idx").on(t.projectId, t.term)],
);

export const ticketNodes = pgTable(
  "ticket_nodes",
  {
    ticketId: uuid("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
    nodeId: uuid("node_id").notNull().references(() => nodes.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.ticketId, t.nodeId] })],
);

// Append-only change log. Powers the activity feed and the AI queue.
export const events = pgTable(
  "events",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    teamId: uuid("team_id").notNull(),
    projectId: uuid("project_id").notNull(),
    actorKind: text("actor_kind", { enum: ["human", "agent"] }).notNull(),
    actorId: uuid("actor_id"),
    actorName: text("actor_name").notNull(),
    type: text("type").notNull(), // e.g. ticket.created, ticket.moved, comment.created
    entity: text("entity", { enum: ["ticket", "comment", "node", "edge", "column", "project", "flow", "decision", "term"] }).notNull(),
    entityId: uuid("entity_id").notNull(),
    summary: text("summary").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    // Client session that made the change (Claude Code session_id), when known. Lets sessions
    // sharing one API key see each other's writes. No FK: sessions are pruned, events never are.
    sessionId: text("session_id"),
    createdAt: createdAt(),
  },
  (t) => [index("events_project_seq_idx").on(t.projectId, t.seq)],
);

// Per-agent read pointer into `events` (the AI queue).
export const agentCursors = pgTable(
  "agent_cursors",
  {
    apiKeyId: uuid("api_key_id").notNull().references(() => apiKeys.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    lastSeq: bigint("last_seq", { mode: "number" }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.apiKeyId, t.projectId] })],
);

/** Server's view of the default branch: content hash per file, updated when code lands. */
export const projectFiles = pgTable(
  "project_files",
  {
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    hash: text("hash").notNull(),
    sha: text("sha"),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.path] })],
);

export type SessionFile = { hash: string | null; at: string; external?: boolean }; // external: changed outside the agent (e.g. a human in the IDE)

/**
 * A client session (e.g. one Claude Code session) working in a project: which
 * files it has changed but not landed, which ticket it's on, when it last
 * checked in. Drives "in flux" on the map and the reconciliation check.
 */
export const workSessions = pgTable(
  "work_sessions",
  {
    id: text("id").primaryKey(), // client-provided session id (Claude Code session_id)
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    actorName: text("actor_name").notNull(),
    client: text("client").notNull().default("unknown"),
    branch: text("branch"),
    ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
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
  (t) => [index("work_sessions_project_idx").on(t.projectId)],
);

/**
 * A map update written against code that hasn't landed yet. Published when the
 * code lands on the default branch, discarded if the work is abandoned.
 */
export const nodeDrafts = pgTable(
  "node_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
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
  (t) => [index("node_drafts_node_idx").on(t.nodeId)],
);
