-- A1 (WH-111): the tenant table is `workspaces` and every tenant column is `workspace_id`. Renames only: no row moves.
ALTER TABLE "teams" RENAME TO "workspaces";--> statement-breakpoint
ALTER TABLE "workspaces" RENAME CONSTRAINT "teams_pkey" TO "workspaces_pkey";--> statement-breakpoint
ALTER TABLE "workspaces" RENAME CONSTRAINT "teams_suspended_by_users_id_fk" TO "workspaces_suspended_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "api_keys" RENAME COLUMN "team_id" TO "workspace_id";--> statement-breakpoint
ALTER TABLE "api_keys" RENAME CONSTRAINT "api_keys_team_id_teams_id_fk" TO "api_keys_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "audit_events" RENAME COLUMN "team_id" TO "workspace_id";--> statement-breakpoint
ALTER INDEX "audit_events_team_seq_idx" RENAME TO "audit_events_workspace_seq_idx";--> statement-breakpoint
ALTER TABLE "events" RENAME COLUMN "team_id" TO "workspace_id";--> statement-breakpoint
ALTER TABLE "github_installations" RENAME COLUMN "team_id" TO "workspace_id";--> statement-breakpoint
ALTER TABLE "github_installations" RENAME CONSTRAINT "github_installations_team_id_teams_id_fk" TO "github_installations_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "invites" RENAME COLUMN "team_id" TO "workspace_id";--> statement-breakpoint
ALTER TABLE "invites" RENAME COLUMN "team_name" TO "workspace_name";--> statement-breakpoint
ALTER TABLE "invites" RENAME CONSTRAINT "invites_team_id_teams_id_fk" TO "invites_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER INDEX "invites_team_idx" RENAME TO "invites_workspace_idx";--> statement-breakpoint
UPDATE "invites" SET "kind" = CASE "kind" WHEN 'new_team' THEN 'new_workspace' WHEN 'join_team' THEN 'join_workspace' ELSE "kind" END;--> statement-breakpoint
ALTER TABLE "memberships" RENAME COLUMN "team_id" TO "workspace_id";--> statement-breakpoint
ALTER TABLE "memberships" RENAME CONSTRAINT "memberships_team_id_teams_id_fk" TO "memberships_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "memberships" RENAME CONSTRAINT "memberships_user_id_team_id_pk" TO "memberships_user_id_workspace_id_pk";--> statement-breakpoint
ALTER TABLE "project_members" RENAME COLUMN "team_id" TO "workspace_id";--> statement-breakpoint
ALTER TABLE "project_members" RENAME CONSTRAINT "project_members_team_id_teams_id_fk" TO "project_members_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "projects" RENAME COLUMN "team_id" TO "workspace_id";--> statement-breakpoint
ALTER TABLE "projects" RENAME CONSTRAINT "projects_team_id_teams_id_fk" TO "projects_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "sessions" RENAME COLUMN "active_team_id" TO "active_workspace_id";--> statement-breakpoint
ALTER TABLE "sessions" RENAME CONSTRAINT "sessions_active_team_id_teams_id_fk" TO "sessions_active_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "seat_limit" integer;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
-- Slug from the name; the oldest workspace keeps the plain slug and a later one with the same slug gets a suffix from its id.
UPDATE "workspaces" w SET "slug" = CASE WHEN r.rn = 1 THEN r.base ELSE r.base || '-' || substr(replace(w."id"::text, '-', ''), 1, 6) END
FROM (
  SELECT "id", base, row_number() OVER (PARTITION BY base ORDER BY "created_at", "id") AS rn
  FROM (SELECT "id", "created_at", COALESCE(NULLIF(trim(both '-' from left(trim(both '-' from lower(regexp_replace("name", '[^a-zA-Z0-9]+', '-', 'g'))), 40)), ''), 'workspace') AS base FROM "workspaces") b
) r
WHERE r."id" = w."id";--> statement-breakpoint
ALTER TABLE "workspaces" ALTER COLUMN "slug" SET DEFAULT replace(gen_random_uuid()::text, '-', '');--> statement-breakpoint
ALTER TABLE "workspaces" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_slug_unique" UNIQUE("slug");
