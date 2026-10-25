CREATE TABLE "team_agents" (
	"team_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"workspace_agent_id" uuid NOT NULL,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_agents_team_id_workspace_agent_id_pk" PRIMARY KEY("team_id","workspace_agent_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"team_id" uuid,
	"slug" text NOT NULL,
	"source" text NOT NULL,
	"catalog_slug" text,
	"pinned_version" integer,
	"profile" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_agents_id_workspace_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "workspace_agents_source_check" CHECK ("source" in ('catalog', 'custom')),
	CONSTRAINT "workspace_agents_shape" CHECK (("workspace_agents"."source" = 'custom' and "workspace_agents"."profile" is not null) or ("workspace_agents"."source" = 'catalog' and "workspace_agents"."catalog_slug" is not null and "workspace_agents"."profile" is null and "workspace_agents"."team_id" is null))
);
--> statement-breakpoint
ALTER TABLE "team_agents" ADD CONSTRAINT "team_agents_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_agents" ADD CONSTRAINT "team_agents_team_fk" FOREIGN KEY ("team_id","workspace_id") REFERENCES "public"."teams"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_agents" ADD CONSTRAINT "team_agents_agent_fk" FOREIGN KEY ("workspace_agent_id","workspace_id") REFERENCES "public"."workspace_agents"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agents" ADD CONSTRAINT "workspace_agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agents" ADD CONSTRAINT "workspace_agents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agents" ADD CONSTRAINT "workspace_agents_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agents" ADD CONSTRAINT "workspace_agents_team_fk" FOREIGN KEY ("team_id","workspace_id") REFERENCES "public"."teams"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_agents_slug_idx" ON "workspace_agents" USING btree ("workspace_id","slug");