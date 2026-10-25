-- A2 (WH-112): today's project is the team. Renames only, plus the stored words that name it (event entity and type, audit action and target, the invite's team list).
ALTER TABLE "project_files" RENAME TO "team_files";--> statement-breakpoint
ALTER TABLE "project_members" RENAME TO "team_members";--> statement-breakpoint
ALTER TABLE "projects" RENAME TO "teams";--> statement-breakpoint
ALTER TABLE "agent_cursors" RENAME COLUMN "project_id" TO "team_id";--> statement-breakpoint
ALTER TABLE "audit_events" RENAME COLUMN "project_id" TO "team_id";--> statement-breakpoint
ALTER TABLE "columns" RENAME COLUMN "project_id" TO "team_id";--> statement-breakpoint
ALTER TABLE "decisions" RENAME COLUMN "project_id" TO "team_id";--> statement-breakpoint
ALTER TABLE "doc_drafts" RENAME COLUMN "project_id" TO "team_id";--> statement-breakpoint
ALTER TABLE "docs" RENAME COLUMN "project_id" TO "team_id";--> statement-breakpoint
ALTER TABLE "edges" RENAME COLUMN "project_id" TO "team_id";--> statement-breakpoint
ALTER TABLE "events" RENAME COLUMN "project_id" TO "team_id";--> statement-breakpoint
ALTER TABLE "flows" RENAME COLUMN "project_id" TO "team_id";--> statement-breakpoint
ALTER TABLE "invites" RENAME COLUMN "projects" TO "teams";--> statement-breakpoint
ALTER TABLE "node_drafts" RENAME COLUMN "project_id" TO "team_id";--> statement-breakpoint
ALTER TABLE "nodes" RENAME COLUMN "project_id" TO "team_id";--> statement-breakpoint
ALTER TABLE "team_files" RENAME COLUMN "project_id" TO "team_id";--> statement-breakpoint
ALTER TABLE "team_members" RENAME COLUMN "project_id" TO "team_id";--> statement-breakpoint
ALTER TABLE "teams" RENAME CONSTRAINT "projects_pkey" TO "teams_pkey";--> statement-breakpoint
ALTER TABLE "repositories" RENAME COLUMN "project_id" TO "team_id";--> statement-breakpoint
ALTER TABLE "terms" RENAME COLUMN "project_id" TO "team_id";--> statement-breakpoint
ALTER TABLE "tickets" RENAME COLUMN "project_id" TO "team_id";--> statement-breakpoint
ALTER TABLE "work_sessions" RENAME COLUMN "project_id" TO "team_id";--> statement-breakpoint
ALTER TABLE "agent_cursors" RENAME CONSTRAINT "agent_cursors_project_id_projects_id_fk" TO "agent_cursors_team_id_teams_id_fk";--> statement-breakpoint
ALTER TABLE "agent_cursors" RENAME CONSTRAINT "agent_cursors_api_key_id_project_id_pk" TO "agent_cursors_api_key_id_team_id_pk";--> statement-breakpoint
ALTER TABLE "columns" RENAME CONSTRAINT "columns_project_id_projects_id_fk" TO "columns_team_id_teams_id_fk";--> statement-breakpoint
ALTER TABLE "decisions" RENAME CONSTRAINT "decisions_project_id_projects_id_fk" TO "decisions_team_id_teams_id_fk";--> statement-breakpoint
ALTER INDEX "decisions_project_number_idx" RENAME TO "decisions_team_number_idx";--> statement-breakpoint
ALTER TABLE "doc_drafts" RENAME CONSTRAINT "doc_drafts_project_id_projects_id_fk" TO "doc_drafts_team_id_teams_id_fk";--> statement-breakpoint
ALTER TABLE "docs" RENAME CONSTRAINT "docs_project_id_projects_id_fk" TO "docs_team_id_teams_id_fk";--> statement-breakpoint
ALTER INDEX "docs_project_idx" RENAME TO "docs_team_idx";--> statement-breakpoint
ALTER INDEX "docs_project_parent_slug_idx" RENAME TO "docs_team_parent_slug_idx";--> statement-breakpoint
ALTER TABLE "edges" RENAME CONSTRAINT "edges_project_id_projects_id_fk" TO "edges_team_id_teams_id_fk";--> statement-breakpoint
ALTER INDEX "events_project_seq_idx" RENAME TO "events_team_seq_idx";--> statement-breakpoint
ALTER TABLE "flows" RENAME CONSTRAINT "flows_project_id_projects_id_fk" TO "flows_team_id_teams_id_fk";--> statement-breakpoint
ALTER TABLE "node_drafts" RENAME CONSTRAINT "node_drafts_project_id_projects_id_fk" TO "node_drafts_team_id_teams_id_fk";--> statement-breakpoint
ALTER TABLE "nodes" RENAME CONSTRAINT "nodes_project_id_projects_id_fk" TO "nodes_team_id_teams_id_fk";--> statement-breakpoint
ALTER TABLE "team_files" RENAME CONSTRAINT "project_files_project_id_projects_id_fk" TO "team_files_team_id_teams_id_fk";--> statement-breakpoint
ALTER TABLE "team_files" RENAME CONSTRAINT "project_files_repository_id_repositories_id_fk" TO "team_files_repository_id_repositories_id_fk";--> statement-breakpoint
ALTER TABLE "team_files" RENAME CONSTRAINT "project_files_project_id_path_pk" TO "team_files_team_id_path_pk";--> statement-breakpoint
ALTER TABLE "team_members" RENAME CONSTRAINT "project_members_project_id_projects_id_fk" TO "team_members_team_id_teams_id_fk";--> statement-breakpoint
ALTER TABLE "team_members" RENAME CONSTRAINT "project_members_user_id_users_id_fk" TO "team_members_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "team_members" RENAME CONSTRAINT "project_members_workspace_id_workspaces_id_fk" TO "team_members_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "team_members" RENAME CONSTRAINT "project_members_added_by_users_id_fk" TO "team_members_added_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "team_members" RENAME CONSTRAINT "project_members_project_id_user_id_pk" TO "team_members_team_id_user_id_pk";--> statement-breakpoint
ALTER INDEX "project_members_user_idx" RENAME TO "team_members_user_idx";--> statement-breakpoint
ALTER TABLE "teams" RENAME CONSTRAINT "projects_workspace_id_workspaces_id_fk" TO "teams_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "repositories" RENAME CONSTRAINT "repositories_project_id_projects_id_fk" TO "repositories_team_id_teams_id_fk";--> statement-breakpoint
ALTER INDEX "repositories_project_idx" RENAME TO "repositories_team_idx";--> statement-breakpoint
ALTER INDEX "repositories_project_slug_idx" RENAME TO "repositories_team_slug_idx";--> statement-breakpoint
ALTER TABLE "terms" RENAME CONSTRAINT "terms_project_id_projects_id_fk" TO "terms_team_id_teams_id_fk";--> statement-breakpoint
ALTER INDEX "terms_project_term_idx" RENAME TO "terms_team_term_idx";--> statement-breakpoint
ALTER TABLE "tickets" RENAME CONSTRAINT "tickets_project_id_projects_id_fk" TO "tickets_team_id_teams_id_fk";--> statement-breakpoint
ALTER INDEX "tickets_project_idx" RENAME TO "tickets_team_idx";--> statement-breakpoint
ALTER INDEX "tickets_project_number_idx" RENAME TO "tickets_team_number_idx";--> statement-breakpoint
ALTER TABLE "work_sessions" RENAME CONSTRAINT "work_sessions_project_id_projects_id_fk" TO "work_sessions_team_id_teams_id_fk";--> statement-breakpoint
ALTER INDEX "work_sessions_project_idx" RENAME TO "work_sessions_team_idx";--> statement-breakpointUPDATE "events" SET "entity" = 'team' WHERE "entity" = 'project';--> statement-breakpoint
UPDATE "events" SET "type" = 'team.' || substr("type", 9) WHERE "type" LIKE 'project.%';--> statement-breakpoint
UPDATE "audit_events" SET "action" = 'team.' || substr("action", 9) WHERE "action" LIKE 'project.%';--> statement-breakpoint
UPDATE "audit_events" SET "target_type" = 'team' WHERE "target_type" = 'project';--> statement-breakpoint
UPDATE "invites" SET "teams" = COALESCE((SELECT jsonb_agg(CASE WHEN e ? 'projectId' THEN (e - 'projectId') || jsonb_build_object('teamId', e->'projectId') ELSE e END) FROM jsonb_array_elements("teams") e), '[]'::jsonb);
