ALTER TABLE "device_jobs" DROP CONSTRAINT "device_jobs_state_check";--> statement-breakpoint
ALTER TABLE "device_jobs" ADD COLUMN "unreachable_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "device_jobs" ADD COLUMN "marked_lost_by" uuid;--> statement-breakpoint
ALTER TABLE "device_jobs" ADD CONSTRAINT "device_jobs_marked_lost_by_users_id_fk" FOREIGN KEY ("marked_lost_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_jobs" ADD CONSTRAINT "device_jobs_state_check" CHECK ("state" in ('offered', 'accepted', 'running', 'unreachable', 'succeeded', 'failed', 'canceled', 'rejected', 'expired', 'lost'));