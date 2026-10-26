ALTER TABLE "chat_threads" DROP CONSTRAINT "chat_threads_device_fk";
--> statement-breakpoint
ALTER TABLE "device_jobs" DROP CONSTRAINT "device_jobs_device_fk";
--> statement-breakpoint
ALTER TABLE "devices" DROP CONSTRAINT "devices_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "devices" DROP CONSTRAINT "devices_owner_membership_fk";
--> statement-breakpoint
DROP INDEX "devices_owner_idx";--> statement-breakpoint
ALTER TABLE "devices" DROP CONSTRAINT "devices_id_workspace_id_unique";--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_device_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_jobs" ADD CONSTRAINT "device_jobs_device_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "devices_owner_idx" ON "devices" USING btree ("owner_id");--> statement-breakpoint
ALTER TABLE "devices" DROP COLUMN "workspace_id";