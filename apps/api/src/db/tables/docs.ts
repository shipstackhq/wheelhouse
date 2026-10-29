import { uuid, text, timestamp, integer, boolean, jsonb, primaryKey, doublePrecision, index, uniqueIndex, unique, foreignKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { table, createdAt, updatedAt } from "./common";
import { teamScope } from "./team-scope";
import { nodes, workSessions } from "./map";

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
    // "markdown" (default) or "drawing" (WH-146): a drawing's body is the Excalidraw scene JSON (<= 2MB, enforced in docs.rules.ts).
    kind: text("kind", { enum: ["markdown", "drawing"] }).notNull().default("markdown"),
    // A drawing's SVG preview, exported by the editor on save (<= 300KB). Always null for markdown docs.
    thumbnail: text("thumbnail"),
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

// ───────── Agent daemon: devices and jobs ─────────
