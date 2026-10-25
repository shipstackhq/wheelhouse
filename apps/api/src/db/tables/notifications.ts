import { sql } from "drizzle-orm";
import { uuid, text, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { table, createdAt } from "./common";
import { users, workspaces } from "./auth";
import { teamScope } from "./team-scope";
import { broadcasts } from "./broadcasts";

// A per-recipient inbox item: something that happened that this person should see. Written by the notifications module's notify(),
// read and marked by the recipient only. `dedupeKey` makes a repeated producer call a no-op for the same recipient.
export const notifications = table(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Null for an instance-level item (a broadcast to everyone): it belongs to the person, not to one workspace, and shows in each of theirs.
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    teamId: uuid("team_id"), // null for workspace-level items; teamScope keeps a set team inside the workspace
    recipientUserId: uuid("recipient_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    bodyFormat: text("body_format", { enum: ["text", "markdown"] }).notNull().default("text"),
    actorKind: text("actor_kind", { enum: ["human", "agent", "system"] }),
    actorId: uuid("actor_id"),
    actorName: text("actor_name"),
    subjectEntity: text("subject_entity"),
    subjectId: uuid("subject_id"),
    href: text("href"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    dedupeKey: text("dedupe_key"),
    // The broadcast this item was fanned out from, when it came from one.
    broadcastId: uuid("broadcast_id").references(() => broadcasts.id, { onDelete: "set null" }),
    readAt: timestamp("read_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }), // soft delete (the Trash); the purge removes the row 30 days later
    createdAt: createdAt(),
  },
  (t) => [
    teamScope("notifications", t),
    uniqueIndex("notifications_recipient_dedupe_idx").on(t.recipientUserId, t.dedupeKey),
    index("notifications_recipient_created_idx").on(t.recipientUserId, t.createdAt.desc()),
    index("notifications_deleted_idx").on(t.deletedAt).where(sql`${t.deletedAt} is not null`),
  ],
);
