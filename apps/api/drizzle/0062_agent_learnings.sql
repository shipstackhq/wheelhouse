CREATE TABLE "agent_learnings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_learnings" ADD CONSTRAINT "agent_learnings_agent_id_workspace_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."workspace_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_learnings" ADD CONSTRAINT "agent_learnings_team_fk" FOREIGN KEY ("team_id","workspace_id") REFERENCES "public"."teams"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_learnings_team_agent_idx" ON "agent_learnings" USING btree ("team_id","agent_id");