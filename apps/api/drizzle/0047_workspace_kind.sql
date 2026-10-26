ALTER TABLE "workspaces" ADD COLUMN "kind" text DEFAULT 'team' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_kind_check" CHECK ("kind" in ('personal', 'team'));