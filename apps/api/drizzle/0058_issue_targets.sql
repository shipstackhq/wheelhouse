CREATE TABLE "issue_targets" (
	"issue_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"base_branch" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "issue_targets_issue_id_repository_id_pk" PRIMARY KEY("issue_id","repository_id")
);
--> statement-breakpoint
ALTER TABLE "issue_targets" ADD CONSTRAINT "issue_targets_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_targets" ADD CONSTRAINT "issue_targets_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;