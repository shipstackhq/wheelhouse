ALTER TABLE "api_keys" ADD COLUMN "chat_message_id" uuid;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "expires_at" timestamp with time zone;