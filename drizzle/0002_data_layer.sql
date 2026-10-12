ALTER TABLE "edges" ADD COLUMN "meta" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "columns" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "indexes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- Tables used to live on the code layer; move them to the new data layer (flat, no code-directory parent).
UPDATE "nodes" SET "layer" = 'data', "parent_id" = NULL WHERE "layer" = 'code' AND "kind" = 'table';
