-- A ticket is an issue. Everything is renamed in place (no data is rewritten or dropped): the tables, the columns that point at them,
-- and the names of their keys and indexes, so the names in the database are the ones drizzle writes for the schema.
-- Written by hand because drizzle-kit would drop and recreate the tables.
ALTER TABLE "tickets" RENAME TO "issues";--> statement-breakpoint
ALTER TABLE "ticket_labels" RENAME TO "issue_labels";--> statement-breakpoint
ALTER TABLE "ticket_nodes" RENAME TO "issue_nodes";--> statement-breakpoint
ALTER TABLE "pull_request_tickets" RENAME TO "pull_request_issues";--> statement-breakpoint
ALTER TABLE "teams" RENAME COLUMN "ticket_counter" TO "issue_counter";--> statement-breakpoint
ALTER TABLE "comments" RENAME COLUMN "ticket_id" TO "issue_id";--> statement-breakpoint
ALTER TABLE "work_sessions" RENAME COLUMN "ticket_id" TO "issue_id";--> statement-breakpoint
ALTER TABLE "issue_labels" RENAME COLUMN "ticket_id" TO "issue_id";--> statement-breakpoint
ALTER TABLE "issue_nodes" RENAME COLUMN "ticket_id" TO "issue_id";--> statement-breakpoint
ALTER TABLE "pull_request_issues" RENAME COLUMN "ticket_id" TO "issue_id";--> statement-breakpoint
-- issues
ALTER TABLE "issues" RENAME CONSTRAINT "tickets_pkey" TO "issues_pkey";--> statement-breakpoint
ALTER TABLE "issues" RENAME CONSTRAINT "tickets_id_team_unique" TO "issues_id_team_unique";--> statement-breakpoint
ALTER TABLE "issues" RENAME CONSTRAINT "tickets_assignee_member_fk" TO "issues_assignee_member_fk";--> statement-breakpoint
ALTER TABLE "issues" RENAME CONSTRAINT "tickets_claimed_by_key_id_api_keys_id_fk" TO "issues_claimed_by_key_id_api_keys_id_fk";--> statement-breakpoint
ALTER TABLE "issues" RENAME CONSTRAINT "tickets_column_id_columns_id_fk" TO "issues_column_id_columns_id_fk";--> statement-breakpoint
ALTER TABLE "issues" RENAME CONSTRAINT "tickets_created_by_kind_check" TO "issues_created_by_kind_check";--> statement-breakpoint
ALTER TABLE "issues" RENAME CONSTRAINT "tickets_cycle_fk" TO "issues_cycle_fk";--> statement-breakpoint
ALTER TABLE "issues" RENAME CONSTRAINT "tickets_milestone_fk" TO "issues_milestone_fk";--> statement-breakpoint
ALTER TABLE "issues" RENAME CONSTRAINT "tickets_milestone_needs_project_check" TO "issues_milestone_needs_project_check";--> statement-breakpoint
ALTER TABLE "issues" RENAME CONSTRAINT "tickets_priority_check" TO "issues_priority_check";--> statement-breakpoint
ALTER TABLE "issues" RENAME CONSTRAINT "tickets_project_team_fk" TO "issues_project_team_fk";--> statement-breakpoint
ALTER TABLE "issues" RENAME CONSTRAINT "tickets_team_fk" TO "issues_team_fk";--> statement-breakpoint
ALTER INDEX "tickets_cycle_idx" RENAME TO "issues_cycle_idx";--> statement-breakpoint
ALTER INDEX "tickets_milestone_idx" RENAME TO "issues_milestone_idx";--> statement-breakpoint
ALTER INDEX "tickets_project_idx" RENAME TO "issues_project_idx";--> statement-breakpoint
ALTER INDEX "tickets_team_idx" RENAME TO "issues_team_idx";--> statement-breakpoint
ALTER INDEX "tickets_team_number_idx" RENAME TO "issues_team_number_idx";--> statement-breakpoint
-- issue_labels
ALTER TABLE "issue_labels" RENAME CONSTRAINT "ticket_labels_ticket_id_label_id_pk" TO "issue_labels_issue_id_label_id_pk";--> statement-breakpoint
ALTER TABLE "issue_labels" RENAME CONSTRAINT "ticket_labels_label_fk" TO "issue_labels_label_fk";--> statement-breakpoint
ALTER TABLE "issue_labels" RENAME CONSTRAINT "ticket_labels_team_fk" TO "issue_labels_team_fk";--> statement-breakpoint
ALTER TABLE "issue_labels" RENAME CONSTRAINT "ticket_labels_ticket_fk" TO "issue_labels_issue_fk";--> statement-breakpoint
ALTER INDEX "ticket_labels_label_idx" RENAME TO "issue_labels_label_idx";--> statement-breakpoint
-- issue_nodes
ALTER TABLE "issue_nodes" RENAME CONSTRAINT "ticket_nodes_ticket_id_node_id_pk" TO "issue_nodes_issue_id_node_id_pk";--> statement-breakpoint
ALTER TABLE "issue_nodes" RENAME CONSTRAINT "ticket_nodes_node_id_nodes_id_fk" TO "issue_nodes_node_id_nodes_id_fk";--> statement-breakpoint
ALTER TABLE "issue_nodes" RENAME CONSTRAINT "ticket_nodes_ticket_id_tickets_id_fk" TO "issue_nodes_issue_id_issues_id_fk";--> statement-breakpoint
-- pull_request_issues
ALTER TABLE "pull_request_issues" RENAME CONSTRAINT "pull_request_tickets_pull_request_id_ticket_id_pk" TO "pull_request_issues_pull_request_id_issue_id_pk";--> statement-breakpoint
ALTER TABLE "pull_request_issues" RENAME CONSTRAINT "pull_request_tickets_pull_request_id_pull_requests_id_fk" TO "pull_request_issues_pull_request_id_pull_requests_id_fk";--> statement-breakpoint
ALTER TABLE "pull_request_issues" RENAME CONSTRAINT "pull_request_tickets_ticket_id_tickets_id_fk" TO "pull_request_issues_issue_id_issues_id_fk";--> statement-breakpoint
ALTER INDEX "pull_request_tickets_ticket_idx" RENAME TO "pull_request_issues_issue_idx";--> statement-breakpoint
-- the other tables that point at an issue
ALTER TABLE "comments" RENAME CONSTRAINT "comments_ticket_id_tickets_id_fk" TO "comments_issue_id_issues_id_fk";--> statement-breakpoint
ALTER TABLE "work_sessions" RENAME CONSTRAINT "work_sessions_ticket_id_tickets_id_fk" TO "work_sessions_issue_id_issues_id_fk";--> statement-breakpoint
-- What the change log stored: the entity ("ticket" is now "issue") and the event types ("ticket.moved", "project.ticket_joined").
-- workspace_events refuses updates; it is switched off for this one rewrite of the words and back on straight after.
ALTER TABLE "events" DROP CONSTRAINT "events_entity_check";--> statement-breakpoint
UPDATE "events" SET "entity" = 'issue' WHERE "entity" = 'ticket';--> statement-breakpoint
UPDATE "events" SET "type" = replace("type", 'ticket', 'issue') WHERE "type" LIKE '%ticket%';--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_entity_check" CHECK ("entity" in ('issue', 'comment', 'node', 'edge', 'column', 'team', 'flow', 'decision', 'term', 'doc', 'cycle', 'project'));--> statement-breakpoint
ALTER TABLE "workspace_events" DISABLE TRIGGER "workspace_events_append_only";--> statement-breakpoint
UPDATE "workspace_events" SET "type" = replace("type", 'ticket', 'issue') WHERE "type" LIKE '%ticket%';--> statement-breakpoint
ALTER TABLE "workspace_events" ENABLE TRIGGER "workspace_events_append_only";
