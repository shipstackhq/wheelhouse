CREATE TABLE "audit_events" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"project_id" uuid,
	"actor_kind" text NOT NULL,
	"actor_id" uuid,
	"actor_name" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"role" text DEFAULT 'editor' NOT NULL,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_members_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_team_seq_idx" ON "audit_events" USING btree ("team_id","seq");--> statement-breakpoint
CREATE INDEX "project_members_user_idx" ON "project_members" USING btree ("user_id","team_id");--> statement-breakpoint
-- Nobody loses access (ADR-23): until now every member of a team saw every project of the team, so every current member
-- becomes an editor of every project in their team, and each team owner becomes the project's admin.
INSERT INTO "project_members" ("project_id", "user_id", "team_id", "role")
SELECT p."id", m."user_id", m."team_id", CASE WHEN m."role" = 'owner' THEN 'admin' ELSE 'editor' END
FROM "memberships" m
JOIN "projects" p ON p."team_id" = m."team_id"
ON CONFLICT DO NOTHING;
