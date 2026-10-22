-- A board column is a status. Renamed in place, like 0029: the table, the issues' pointer to it, and the names of their keys and indexes.
-- Written by hand because drizzle-kit would drop and recreate the table.
ALTER TABLE "columns" RENAME TO "statuses";--> statement-breakpoint
ALTER TABLE "issues" RENAME COLUMN "column_id" TO "status_id";--> statement-breakpoint
ALTER TABLE "statuses" RENAME CONSTRAINT "columns_pkey" TO "statuses_pkey";--> statement-breakpoint
ALTER TABLE "statuses" RENAME CONSTRAINT "columns_role_check" TO "statuses_role_check";--> statement-breakpoint
ALTER TABLE "statuses" RENAME CONSTRAINT "columns_team_fk" TO "statuses_team_fk";--> statement-breakpoint
ALTER TABLE "issues" RENAME CONSTRAINT "issues_column_id_columns_id_fk" TO "issues_status_id_statuses_id_fk";--> statement-breakpoint
ALTER INDEX "columns_team_role_idx" RENAME TO "statuses_team_role_idx";--> statement-breakpoint
-- What the change log stored: the entity ("column" is now "status") and the status an issue was created in (data.column is data.status).
ALTER TABLE "events" DROP CONSTRAINT "events_entity_check";--> statement-breakpoint
UPDATE "events" SET "entity" = 'status' WHERE "entity" = 'column';--> statement-breakpoint
UPDATE "events" SET "data" = ("data" - 'column') || jsonb_build_object('status', "data" -> 'column') WHERE "type" = 'issue.created' AND "data" ? 'column';--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_entity_check" CHECK ("entity" in ('issue', 'comment', 'node', 'edge', 'status', 'team', 'flow', 'decision', 'term', 'doc', 'cycle', 'project'));
