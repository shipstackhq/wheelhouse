-- WH-118: projects (deliverables), the teams that take part, milestones, a ticket's project and milestone, workspace_events, and who can see a project. The keys below are written here because drizzle cannot say DEFERRABLE or SET NULL on named columns, and the view is not managed by drizzle.
CREATE TABLE "project_milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"target_date" date,
	"position" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_milestones_id_project_unique" UNIQUE("id","project_id")
);
--> statement-breakpoint
CREATE TABLE "project_teams" (
	"project_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	CONSTRAINT "project_teams_project_id_team_id_pk" PRIMARY KEY("project_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"lead_user_id" uuid,
	"lead_team_id" uuid NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"start_date" date,
	"target_date" date,
	"health_override" text,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_id_workspace_id_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "projects_status_check" CHECK ("status" in ('planned', 'active', 'paused', 'completed', 'canceled')),
	CONSTRAINT "projects_health_override_check" CHECK ("health_override" in ('on_track', 'at_risk', 'off_track')),
	CONSTRAINT "projects_dates_check" CHECK ("start_date" is null or "target_date" is null or "target_date" >= "start_date")
);
--> statement-breakpoint
CREATE TABLE "workspace_events" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" uuid,
	"actor_name" text NOT NULL,
	"type" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_events_actor_kind_check" CHECK ("actor_kind" in ('human', 'agent')),
	CONSTRAINT "workspace_events_entity_check" CHECK ("entity" in ('project', 'initiative'))
);
--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_entity_check";--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "milestone_id" uuid;--> statement-breakpoint
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_project_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."projects"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_teams" ADD CONSTRAINT "project_teams_team_fk" FOREIGN KEY ("team_id","workspace_id") REFERENCES "public"."teams"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_teams" ADD CONSTRAINT "project_teams_project_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."projects"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_events" ADD CONSTRAINT "workspace_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_milestones_project_idx" ON "project_milestones" USING btree ("project_id","position");--> statement-breakpoint
CREATE INDEX "project_teams_team_idx" ON "project_teams" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "projects_workspace_idx" ON "projects" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "workspace_events_workspace_seq_idx" ON "workspace_events" USING btree ("workspace_id","seq");--> statement-breakpoint
CREATE INDEX "tickets_project_idx" ON "tickets" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "tickets_milestone_idx" ON "tickets" USING btree ("milestone_id");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_entity_check" CHECK ("entity" in ('ticket', 'comment', 'node', 'edge', 'column', 'team', 'flow', 'decision', 'term', 'doc', 'cycle', 'project'));--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_milestone_needs_project_check" CHECK ("milestone_id" is null or "project_id" is not null);--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_lead_user_fk" FOREIGN KEY ("lead_user_id","workspace_id") REFERENCES "public"."memberships"("user_id","workspace_id") ON DELETE SET NULL ("lead_user_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_lead_team_fk" FOREIGN KEY ("lead_team_id","id") REFERENCES "public"."project_teams"("team_id","project_id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_project_team_fk" FOREIGN KEY ("project_id","team_id") REFERENCES "public"."project_teams"("project_id","team_id") ON DELETE SET NULL ("project_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_milestone_fk" FOREIGN KEY ("milestone_id","project_id") REFERENCES "public"."project_milestones"("id","project_id") ON DELETE SET NULL ("milestone_id") ON UPDATE no action;--> statement-breakpoint
CREATE VIEW "project_visibility" AS
  SELECT DISTINCT tm."user_id", pt."project_id"
  FROM "project_teams" pt
  JOIN "projects" p ON p."id" = pt."project_id" AND p."deleted_at" IS NULL
  JOIN "team_members" tm ON tm."team_id" = pt."team_id"
  JOIN "memberships" m ON m."user_id" = tm."user_id" AND m."workspace_id" = tm."workspace_id"
  WHERE m."role" <> 'guest';
