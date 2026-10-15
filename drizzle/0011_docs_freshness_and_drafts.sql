CREATE TABLE "doc_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"doc_id" uuid NOT NULL,
	"session_id" text,
	"author_name" text NOT NULL,
	"author_kind" text NOT NULL,
	"patch" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confirm" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "docs" ADD COLUMN "anchors" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "docs" ADD COLUMN "described_sha" text;--> statement-breakpoint
ALTER TABLE "docs" ADD COLUMN "described_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "docs" ADD COLUMN "stale" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "docs" ADD COLUMN "stale_reason" text;--> statement-breakpoint
ALTER TABLE "docs" ADD COLUMN "stale_source" text;--> statement-breakpoint
ALTER TABLE "docs" ADD COLUMN "described_hashes" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "docs" ADD COLUMN "drift_paths" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "doc_drafts" ADD CONSTRAINT "doc_drafts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_drafts" ADD CONSTRAINT "doc_drafts_doc_id_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_drafts" ADD CONSTRAINT "doc_drafts_session_id_work_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."work_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doc_drafts_doc_idx" ON "doc_drafts" USING btree ("doc_id");