ALTER TABLE "events" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD COLUMN "last_seq" bigint;