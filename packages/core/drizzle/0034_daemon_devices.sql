-- The agent daemon (WH daemon MVP): paired devices, their pairing flow and short-lived tokens, the signed messages each device's stream
-- replays, jobs (one per "Run on device") with their progress, and the instance's own signing key.
CREATE TABLE "device_job_events" (
	"job_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"type" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "device_job_events_job_id_seq_pk" PRIMARY KEY("job_id","seq")
);
--> statement-breakpoint
CREATE TABLE "device_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"repository_id" uuid,
	"model" text NOT NULL,
	"state" text DEFAULT 'offered' NOT NULL,
	"branch" text NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_by" uuid,
	"offer_expires_at" timestamp with time zone NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_jobs_state_check" CHECK ("state" in ('offered', 'accepted', 'running', 'succeeded', 'failed', 'canceled', 'rejected', 'expired', 'lost'))
);
--> statement-breakpoint
CREATE TABLE "device_messages" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"device_id" uuid NOT NULL,
	"type" text NOT NULL,
	"message" jsonb NOT NULL,
	"signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_messages_type_check" CHECK ("type" in ('job.offer', 'job.cancel', 'settings.update'))
);
--> statement-breakpoint
CREATE TABLE "device_pairings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_code_hash" text NOT NULL,
	"user_code" text NOT NULL,
	"public_key" text NOT NULL,
	"name" text NOT NULL,
	"os" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"device_id" uuid,
	"last_polled_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_pairings_device_code_hash_unique" UNIQUE("device_code_hash"),
	CONSTRAINT "device_pairings_user_code_unique" UNIQUE("user_code"),
	CONSTRAINT "device_pairings_state_check" CHECK ("state" in ('pending', 'approved', 'denied', 'consumed'))
);
--> statement-breakpoint
CREATE TABLE "device_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"device_id" uuid NOT NULL,
	"jti" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_tokens_jti_unique" UNIQUE("jti")
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"os" text NOT NULL,
	"public_key" text NOT NULL,
	"daemon_version" text,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pool_size" integer DEFAULT 3 NOT NULL,
	"chat_model" text,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_public_key_unique" UNIQUE("public_key"),
	CONSTRAINT "devices_id_workspace_id_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "devices_pool_size_check" CHECK ("pool_size" between 1 and 8)
);
--> statement-breakpoint
CREATE TABLE "instance_keys" (
	"name" text PRIMARY KEY NOT NULL,
	"private_key" text NOT NULL,
	"public_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device_job_events" ADD CONSTRAINT "device_job_events_job_id_device_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."device_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_jobs" ADD CONSTRAINT "device_jobs_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_jobs" ADD CONSTRAINT "device_jobs_team_fk" FOREIGN KEY ("team_id","workspace_id") REFERENCES "public"."teams"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_jobs" ADD CONSTRAINT "device_jobs_device_fk" FOREIGN KEY ("device_id","workspace_id") REFERENCES "public"."devices"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_jobs" ADD CONSTRAINT "device_jobs_issue_fk" FOREIGN KEY ("issue_id","team_id") REFERENCES "public"."issues"("id","team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_messages" ADD CONSTRAINT "device_messages_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_pairings" ADD CONSTRAINT "device_pairings_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_owner_membership_fk" FOREIGN KEY ("owner_id","workspace_id") REFERENCES "public"."memberships"("user_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_jobs_issue_idx" ON "device_jobs" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "device_jobs_device_state_idx" ON "device_jobs" USING btree ("device_id","state");--> statement-breakpoint
CREATE INDEX "device_messages_device_seq_idx" ON "device_messages" USING btree ("device_id","seq");--> statement-breakpoint
CREATE INDEX "device_tokens_device_idx" ON "device_tokens" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "devices_owner_idx" ON "devices" USING btree ("owner_id","workspace_id");