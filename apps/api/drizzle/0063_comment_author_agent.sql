ALTER TABLE "comments" ADD COLUMN "author_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "idea_comments" ADD COLUMN "author_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_agent_id_workspace_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."workspace_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_comments" ADD CONSTRAINT "idea_comments_author_agent_id_workspace_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."workspace_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "comments" SET "author_agent_id" = "author_id" WHERE "author_kind" = 'agent' AND "author_id" IN (SELECT "id" FROM "workspace_agents");--> statement-breakpoint
UPDATE "idea_comments" SET "author_agent_id" = "author_id" WHERE "author_kind" = 'agent' AND "author_id" IN (SELECT "id" FROM "workspace_agents");
