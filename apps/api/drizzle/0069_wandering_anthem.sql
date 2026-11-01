ALTER TABLE "repositories" ADD COLUMN "ci_policy" jsonb;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "ci_detected" jsonb;