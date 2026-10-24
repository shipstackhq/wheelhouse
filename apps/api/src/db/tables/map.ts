import { uuid, text, timestamp, integer, boolean, jsonb, bigint, primaryKey, doublePrecision, index, uniqueIndex, unique, foreignKey } from "drizzle-orm/pg-core";
import { table, createdAt, updatedAt } from "./common";
import { teamScope } from "./team-scope";
import { apiKeys } from "./auth";
import { issues } from "./issues";

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
