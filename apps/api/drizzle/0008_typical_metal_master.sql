CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"role" text NOT NULL,
	"provider" text DEFAULT 'local' NOT NULL,
	"slug" text NOT NULL,
	"github_repo_id" text,
	"github_installation_id" text,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"path_limit" text,
	"lifecycle" text DEFAULT 'live' NOT NULL,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_files" ADD COLUMN "repository_id" uuid;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repositories_project_idx" ON "repositories" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_project_slug_idx" ON "repositories" USING btree ("project_id","slug");--> statement-breakpoint
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;