CREATE TABLE "broadcasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"source" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"body_format" text DEFAULT 'text' NOT NULL,
	"href" text,
	"actor_name" text NOT NULL,
	"audience" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"delivered" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "broadcasts_key_unique" UNIQUE("key"),
	CONSTRAINT "broadcasts_body_format_check" CHECK ("body_format" in ('text', 'markdown')),
	CONSTRAINT "broadcasts_status_check" CHECK ("status" in ('pending', 'sending', 'done', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "workspace_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "broadcast_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE set null ON UPDATE no action;