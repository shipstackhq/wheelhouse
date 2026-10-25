import { uuid, text, jsonb, integer, timestamp } from "drizzle-orm/pg-core";
import { table, createdAt } from "./common";

export const BROADCAST_STATUSES = ["pending", "sending", "done", "failed"] as const;

// One message sent to an audience: the campaign record behind the inbox items it fans out into. `key` is the sender's own name for
// the send, unique, so sending the same broadcast twice (a retry, a crash halfway) delivers it once.
export const broadcasts = table("broadcasts", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  source: text("source").notNull(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  bodyFormat: text("body_format", { enum: ["text", "markdown"] }).notNull().default("text"),
  href: text("href"),
  actorName: text("actor_name").notNull(),
  audience: jsonb("audience").$type<Record<string, unknown>>().notNull(),
  status: text("status", { enum: BROADCAST_STATUSES }).notNull().default("pending"),
  // Inbox items created so far (a recipient that already had one does not count).
  delivered: integer("delivered").notNull().default(0),
  error: text("error"),
  createdAt: createdAt(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});
