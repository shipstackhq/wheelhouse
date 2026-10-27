ALTER TABLE "ideas" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "labels" jsonb DEFAULT '[]'::jsonb NOT NULL;