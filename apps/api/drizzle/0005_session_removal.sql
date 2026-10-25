ALTER TABLE "work_sessions" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD COLUMN "resume_from_seq" bigint;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD COLUMN "resume_removed_at" timestamp with time zone;