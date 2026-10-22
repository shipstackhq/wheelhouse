ALTER TABLE "teams" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "retired_by" uuid;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_retired_by_users_id_fk" FOREIGN KEY ("retired_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_parent_fk" FOREIGN KEY ("parent_id","workspace_id") REFERENCES "public"."teams"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "teams_workspace_parent_idx" ON "teams" USING btree ("workspace_id","parent_id");--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_not_own_parent_check" CHECK ("parent_id" <> "id");