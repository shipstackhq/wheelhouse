-- WH-119: initiatives and the projects they group. The owner key is written here because drizzle cannot say SET NULL on named columns; workspace_events becomes append-only (a delete is allowed only as the cascade of deleting its workspace).
CREATE TABLE "initiative_projects" (
	"initiative_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	CONSTRAINT "initiative_projects_initiative_id_project_id_pk" PRIMARY KEY("initiative_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "initiatives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"owner_id" uuid,
	"status" text DEFAULT 'planned' NOT NULL,
	"target_date" date,
	"health_override" text,
	"position" double precision DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "initiatives_id_workspace_id_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "initiatives_status_check" CHECK ("status" in ('planned', 'active', 'paused', 'done')),
	CONSTRAINT "initiatives_health_override_check" CHECK ("health_override" in ('on_track', 'at_risk', 'off_track')),
	CONSTRAINT "initiatives_not_own_parent_check" CHECK ("parent_id" is null or "parent_id" <> "id")
);
--> statement-breakpoint
ALTER TABLE "initiative_projects" ADD CONSTRAINT "initiative_projects_initiative_fk" FOREIGN KEY ("initiative_id","workspace_id") REFERENCES "public"."initiatives"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "initiative_projects" ADD CONSTRAINT "initiative_projects_project_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."projects"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "initiatives" ADD CONSTRAINT "initiatives_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "initiatives" ADD CONSTRAINT "initiatives_parent_fk" FOREIGN KEY ("parent_id","workspace_id") REFERENCES "public"."initiatives"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "initiative_projects_project_idx" ON "initiative_projects" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "initiatives_workspace_idx" ON "initiatives" USING btree ("workspace_id","parent_id");--> statement-breakpoint
ALTER TABLE "initiatives" ADD CONSTRAINT "initiatives_owner_fk" FOREIGN KEY ("owner_id","workspace_id") REFERENCES "public"."memberships"("user_id","workspace_id") ON DELETE SET NULL ("owner_id") ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION "workspace_events_append_only"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'workspace_events is append-only' USING ERRCODE = 'restrict_violation';
  END IF;
  -- A delete is only the cascade of deleting the whole workspace, which has already gone by the time this runs.
  IF EXISTS (SELECT 1 FROM "workspaces" WHERE "id" = OLD."workspace_id") THEN
    RAISE EXCEPTION 'workspace_events is append-only' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "workspace_events_append_only" BEFORE UPDATE OR DELETE ON "workspace_events" FOR EACH ROW EXECUTE FUNCTION "workspace_events_append_only"();
