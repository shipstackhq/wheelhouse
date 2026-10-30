ALTER TABLE "docs" ADD COLUMN "kind" text DEFAULT 'markdown' NOT NULL;--> statement-breakpoint
ALTER TABLE "docs" ADD COLUMN "thumbnail" text;
