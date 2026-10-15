CREATE TABLE "doc_nodes" (
	"doc_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	CONSTRAINT "doc_nodes_doc_id_node_id_pk" PRIMARY KEY("doc_id","node_id")
);
--> statement-breakpoint
CREATE TABLE "docs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"parent_id" uuid,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"position" double precision DEFAULT 0 NOT NULL,
	"created_by_kind" text NOT NULL,
	"created_by_id" uuid,
	"updated_by_kind" text NOT NULL,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "doc_nodes" ADD CONSTRAINT "doc_nodes_doc_id_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_nodes" ADD CONSTRAINT "doc_nodes_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs" ADD CONSTRAINT "docs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "docs_project_idx" ON "docs" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "docs_project_parent_slug_idx" ON "docs" USING btree ("project_id","parent_id","slug") WHERE deleted_at is null;