CREATE TABLE "project_repositories" (
	"project_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"branch" text,
	CONSTRAINT "project_repositories_project_id_repository_id_pk" PRIMARY KEY("project_id","repository_id")
);
--> statement-breakpoint
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;