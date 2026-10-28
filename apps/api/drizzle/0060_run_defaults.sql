CREATE TABLE "run_defaults" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"device_id" uuid,
	"model" text,
	"effort" text,
	CONSTRAINT "run_defaults_effort_check" CHECK ("effort" in ('low', 'medium', 'high'))
);
--> statement-breakpoint
ALTER TABLE "run_defaults" ADD CONSTRAINT "run_defaults_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_defaults" ADD CONSTRAINT "run_defaults_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;