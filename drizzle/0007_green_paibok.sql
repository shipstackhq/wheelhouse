ALTER TABLE "teams" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "suspended_by" uuid;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "suspended_reason" text;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_suspended_by_users_id_fk" FOREIGN KEY ("suspended_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;