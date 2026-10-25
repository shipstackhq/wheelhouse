CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'done' NOT NULL,
	"error" text,
	"activity" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_event_seq" integer DEFAULT -1 NOT NULL,
	"cost_usd" numeric(12, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_messages_thread_seq_unique" UNIQUE("thread_id","seq"),
	CONSTRAINT "chat_messages_role_check" CHECK ("role" in ('user', 'assistant')),
	CONSTRAINT "chat_messages_state_check" CHECK ("state" in ('done', 'pending', 'streaming', 'failed', 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "chat_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"repository_id" uuid,
	"model" text NOT NULL,
	"title" text NOT NULL,
	"session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device_messages" DROP CONSTRAINT "device_messages_type_check";--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_team_fk" FOREIGN KEY ("team_id","workspace_id") REFERENCES "public"."teams"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_team_fk" FOREIGN KEY ("team_id","workspace_id") REFERENCES "public"."teams"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_device_fk" FOREIGN KEY ("device_id","workspace_id") REFERENCES "public"."devices"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_owner_membership_fk" FOREIGN KEY ("owner_id","workspace_id") REFERENCES "public"."memberships"("user_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_one_running_idx" ON "chat_messages" USING btree ("thread_id") WHERE "role" = 'assistant' and "state" in ('pending', 'streaming');--> statement-breakpoint
CREATE INDEX "chat_messages_state_idx" ON "chat_messages" USING btree ("state","updated_at");--> statement-breakpoint
CREATE INDEX "chat_threads_owner_idx" ON "chat_threads" USING btree ("owner_id","workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "chat_threads_device_idx" ON "chat_threads" USING btree ("device_id");--> statement-breakpoint
ALTER TABLE "device_messages" ADD CONSTRAINT "device_messages_type_check" CHECK ("type" in ('job.offer', 'job.cancel', 'settings.update', 'chat.message', 'chat.cancel'));