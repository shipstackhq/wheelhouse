import { uuid, text, index, integer, jsonb } from "drizzle-orm/pg-core";
import { table, createdAt, updatedAt } from "./common";
import { workspaces } from "./auth";
import { teams } from "./teams";
import { issues } from "./issues";

export const IDEA_STATUSES = ["new", "exploring", "promoted", "parked"] as const;

export type IdeaStatus = (typeof IDEA_STATUSES)[number];

/**
 * An idea (WH-109): a low-commitment note that is not yet work. It belongs to the workspace; the team is only a tag. It has no
 * priority, estimate, assignee or cycle: those come on the issue it is promoted to (`promoted_issue_id`, cleared if that issue is deleted).
 */
export const ideas = table(
  "ideas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    status: text("status", { enum: IDEA_STATUSES }).notNull().default("new"),
    authorKind: text("author_kind", { enum: ["human", "agent"] }).notNull(),
    authorId: uuid("author_id"),
    authorName: text("author_name").notNull(),
    promotedIssueId: uuid("promoted_issue_id").references(() => issues.id, { onDelete: "set null" }),
    // WH-110: the optimistic lock (every change bumps it) and free-text tags, as on docs.
    version: integer("version").notNull().default(1),
    labels: jsonb("labels").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("ideas_workspace_idx").on(t.workspaceId, t.createdAt)],
);

export const ideaComments = table("idea_comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  ideaId: uuid("idea_id").notNull().references(() => ideas.id, { onDelete: "cascade" }),
  authorKind: text("author_kind", { enum: ["human", "agent"] }).notNull(),
  authorId: uuid("author_id"),
  authorName: text("author_name").notNull(),
  body: text("body").notNull(),
  createdAt: createdAt(),
});
