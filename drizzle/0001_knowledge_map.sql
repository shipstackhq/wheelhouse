CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'accepted' NOT NULL,
	"context" text DEFAULT '' NOT NULL,
	"decision" text DEFAULT '' NOT NULL,
	"consequences" text DEFAULT '' NOT NULL,
	"node_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"author_kind" text NOT NULL,
	"author_name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"term" text NOT NULL,
	"definition" text NOT NULL,
	"node_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "edges" ADD COLUMN "kind" text DEFAULT 'depends' NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "layer" text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "purpose" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "responsibilities" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "interfaces" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "gotchas" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "anchors" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "described_sha" text;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "described_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "stale" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "stale_reason" text;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flows" ADD CONSTRAINT "flows_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms" ADD CONSTRAINT "terms_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms" ADD CONSTRAINT "terms_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "decisions_project_number_idx" ON "decisions" USING btree ("project_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "terms_project_term_idx" ON "terms" USING btree ("project_id","term");