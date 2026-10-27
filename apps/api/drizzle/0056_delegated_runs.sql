ALTER TABLE "issues" ADD COLUMN "delegated_by" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "delegated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "device_jobs" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "device_jobs" ADD CONSTRAINT "device_jobs_agent_id_workspace_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."workspace_agents"("id") ON DELETE set null ON UPDATE no action;