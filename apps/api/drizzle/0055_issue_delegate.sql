ALTER TABLE "issues" ADD COLUMN "delegate_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_delegate_agent_id_workspace_agents_id_fk" FOREIGN KEY ("delegate_agent_id") REFERENCES "public"."workspace_agents"("id") ON DELETE set null ON UPDATE no action;
