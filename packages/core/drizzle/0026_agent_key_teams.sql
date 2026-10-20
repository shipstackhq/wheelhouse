-- WH-120: the teams an agent key can open. Every existing key is given every team of its workspace, so no agent loses access on the day; an owner narrows them afterwards.
CREATE TABLE "api_key_teams" (
	"api_key_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	CONSTRAINT "api_key_teams_api_key_id_team_id_pk" PRIMARY KEY("api_key_id","team_id")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_id_workspace_id_unique" UNIQUE("id","workspace_id");--> statement-breakpoint
ALTER TABLE "api_key_teams" ADD CONSTRAINT "api_key_teams_team_fk" FOREIGN KEY ("team_id","workspace_id") REFERENCES "public"."teams"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_teams" ADD CONSTRAINT "api_key_teams_key_fk" FOREIGN KEY ("api_key_id","workspace_id") REFERENCES "public"."api_keys"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_key_teams_team_idx" ON "api_key_teams" USING btree ("team_id");--> statement-breakpoint
INSERT INTO "api_key_teams" ("api_key_id", "team_id", "workspace_id") SELECT k."id", t."id", t."workspace_id" FROM "api_keys" k JOIN "teams" t ON t."workspace_id" = k."workspace_id";
