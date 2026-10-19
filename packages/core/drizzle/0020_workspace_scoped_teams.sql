-- A3, A6, A7 (WH-113): every team-scoped row carries its workspace and the database makes the two agree; team members are workspace members; assignees are team members.
ALTER TABLE "teams" ADD CONSTRAINT "teams_id_workspace_id_unique" UNIQUE("id","workspace_id");--> statement-breakpoint
ALTER TABLE "agent_cursors" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "columns" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "doc_drafts" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "docs" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "edges" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "flows" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "node_drafts" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "team_files" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "terms" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
UPDATE "agent_cursors" x SET "workspace_id" = t."workspace_id" FROM "teams" t WHERE t."id" = x."team_id";--> statement-breakpoint
UPDATE "columns" x SET "workspace_id" = t."workspace_id" FROM "teams" t WHERE t."id" = x."team_id";--> statement-breakpoint
UPDATE "decisions" x SET "workspace_id" = t."workspace_id" FROM "teams" t WHERE t."id" = x."team_id";--> statement-breakpoint
UPDATE "doc_drafts" x SET "workspace_id" = t."workspace_id" FROM "teams" t WHERE t."id" = x."team_id";--> statement-breakpoint
UPDATE "docs" x SET "workspace_id" = t."workspace_id" FROM "teams" t WHERE t."id" = x."team_id";--> statement-breakpoint
UPDATE "edges" x SET "workspace_id" = t."workspace_id" FROM "teams" t WHERE t."id" = x."team_id";--> statement-breakpoint
UPDATE "flows" x SET "workspace_id" = t."workspace_id" FROM "teams" t WHERE t."id" = x."team_id";--> statement-breakpoint
UPDATE "node_drafts" x SET "workspace_id" = t."workspace_id" FROM "teams" t WHERE t."id" = x."team_id";--> statement-breakpoint
UPDATE "nodes" x SET "workspace_id" = t."workspace_id" FROM "teams" t WHERE t."id" = x."team_id";--> statement-breakpoint
UPDATE "repositories" x SET "workspace_id" = t."workspace_id" FROM "teams" t WHERE t."id" = x."team_id";--> statement-breakpoint
UPDATE "team_files" x SET "workspace_id" = t."workspace_id" FROM "teams" t WHERE t."id" = x."team_id";--> statement-breakpoint
UPDATE "terms" x SET "workspace_id" = t."workspace_id" FROM "teams" t WHERE t."id" = x."team_id";--> statement-breakpoint
UPDATE "tickets" x SET "workspace_id" = t."workspace_id" FROM "teams" t WHERE t."id" = x."team_id";--> statement-breakpoint
UPDATE "work_sessions" x SET "workspace_id" = t."workspace_id" FROM "teams" t WHERE t."id" = x."team_id";--> statement-breakpoint
ALTER TABLE "agent_cursors" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "columns" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "decisions" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "doc_drafts" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "docs" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "edges" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "flows" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "node_drafts" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "team_files" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "terms" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "work_sessions" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
-- team_members already carried workspace_id; a row for someone who is not a member of that workspace cannot stay.
DELETE FROM "team_members" tm WHERE tm."workspace_id" <> (SELECT t."workspace_id" FROM "teams" t WHERE t."id" = tm."team_id") OR NOT EXISTS (SELECT 1 FROM "memberships" m WHERE m."user_id" = tm."user_id" AND m."workspace_id" = tm."workspace_id");--> statement-breakpoint
-- An assignee who is not on the ticket's team is unassigned (least access); the count shows in the migration log.
DO $$ DECLARE n integer; BEGIN UPDATE "tickets" k SET "assignee_id" = NULL WHERE k."assignee_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "team_members" tm WHERE tm."team_id" = k."team_id" AND tm."user_id" = k."assignee_id"); GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN RAISE NOTICE 'WH-113: unassigned % ticket(s) whose assignee is not on the ticket''s team', n; END IF; END $$;--> statement-breakpoint
ALTER TABLE "team_members" DROP CONSTRAINT "team_members_team_id_teams_id_fk";--> statement-breakpoint
ALTER TABLE "team_members" DROP CONSTRAINT "team_members_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "team_members" DROP CONSTRAINT "team_members_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "agent_cursors" DROP CONSTRAINT "agent_cursors_team_id_teams_id_fk";--> statement-breakpoint
ALTER TABLE "columns" DROP CONSTRAINT "columns_team_id_teams_id_fk";--> statement-breakpoint
ALTER TABLE "decisions" DROP CONSTRAINT "decisions_team_id_teams_id_fk";--> statement-breakpoint
ALTER TABLE "doc_drafts" DROP CONSTRAINT "doc_drafts_team_id_teams_id_fk";--> statement-breakpoint
ALTER TABLE "docs" DROP CONSTRAINT "docs_team_id_teams_id_fk";--> statement-breakpoint
ALTER TABLE "edges" DROP CONSTRAINT "edges_team_id_teams_id_fk";--> statement-breakpoint
ALTER TABLE "flows" DROP CONSTRAINT "flows_team_id_teams_id_fk";--> statement-breakpoint
ALTER TABLE "node_drafts" DROP CONSTRAINT "node_drafts_team_id_teams_id_fk";--> statement-breakpoint
ALTER TABLE "nodes" DROP CONSTRAINT "nodes_team_id_teams_id_fk";--> statement-breakpoint
ALTER TABLE "repositories" DROP CONSTRAINT "repositories_team_id_teams_id_fk";--> statement-breakpoint
ALTER TABLE "team_files" DROP CONSTRAINT "team_files_team_id_teams_id_fk";--> statement-breakpoint
ALTER TABLE "terms" DROP CONSTRAINT "terms_team_id_teams_id_fk";--> statement-breakpoint
ALTER TABLE "tickets" DROP CONSTRAINT "tickets_team_id_teams_id_fk";--> statement-breakpoint
ALTER TABLE "tickets" DROP CONSTRAINT "tickets_assignee_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "work_sessions" DROP CONSTRAINT "work_sessions_team_id_teams_id_fk";--> statement-breakpoint
ALTER TABLE "agent_cursors" ADD CONSTRAINT "agent_cursors_team_fk" FOREIGN KEY ("team_id","workspace_id") REFERENCES "public"."teams"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "columns" ADD CONSTRAINT "columns_team_fk" FOREIGN KEY ("team_id","workspace_id") REFERENCES "public"."teams"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_team_fk" FOREIGN KEY ("team_id","workspace_id") REFERENCES "public"."teams"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_drafts" ADD CONSTRAINT "doc_drafts_team_fk" FOREIGN KEY ("team_id","workspace_id") REFERENCES "public"."teams"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs" ADD CONSTRAINT "docs_team_fk" FOREIGN KEY ("team_id","workspace_id") REFERENCES "public"."teams"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_team_fk" FOREIGN KEY ("team_id","workspace_id") REFERENCES "public"."teams"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flows" ADD CONSTRAINT "flows_team_fk" FOREIGN KEY ("team_id","workspace_id") REFERENCES "public"."teams"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_drafts" ADD CONSTRAINT "node_drafts_team_fk" FOREIGN KEY ("team_id","workspace_id") REFERENCES "public"."teams"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_team_fk" FOREIGN KEY ("team_id","workspace_id") REFERENCES "public"."teams"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_team_fk" FOREIGN KEY ("team_id","workspace_id") REFERENCES "public"."teams"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_files" ADD CONSTRAINT "team_files_team_fk" FOREIGN KEY ("team_id","workspace_id") REFERENCES "public"."teams"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms" ADD CONSTRAINT "terms_team_fk" FOREIGN KEY ("team_id","workspace_id") REFERENCES "public"."teams"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_team_fk" FOREIGN KEY ("team_id","workspace_id") REFERENCES "public"."teams"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_team_fk" FOREIGN KEY ("team_id","workspace_id") REFERENCES "public"."teams"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_fk" FOREIGN KEY ("team_id","workspace_id") REFERENCES "public"."teams"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_membership_fk" FOREIGN KEY ("user_id","workspace_id") REFERENCES "public"."memberships"("user_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Not in the drizzle schema: drizzle cannot write the column list. Removing someone from a team unassigns their tickets and leaves team_id alone.
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assignee_member_fk" FOREIGN KEY ("team_id","assignee_id") REFERENCES "public"."team_members"("team_id","user_id") ON DELETE SET NULL ("assignee_id") ON UPDATE no action;
