-- A9 (WH-115): the JSON arrays decisions.node_ids, invites.teams and tickets.labels become rows. A guard stops the migration, changing nothing, if any entry points at something missing; run `pnpm db:preflight` first.
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_id_team_unique" UNIQUE("id","team_id");
--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_id_workspace_id_unique" UNIQUE("id","workspace_id");
--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_id_team_unique" UNIQUE("id","team_id");
--> statement-breakpoint
CREATE TABLE "decision_nodes" (
	"decision_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	CONSTRAINT "decision_nodes_decision_id_node_id_pk" PRIMARY KEY("decision_id","node_id")
);
--> statement-breakpoint
CREATE TABLE "invite_teams" (
	"invite_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"role" text DEFAULT 'editor' NOT NULL,
	CONSTRAINT "invite_teams_invite_id_team_id_pk" PRIMARY KEY("invite_id","team_id"),
	CONSTRAINT "invite_teams_role_check" CHECK ("role" in ('admin', 'editor', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "labels_id_team_unique" UNIQUE("id","team_id")
);
--> statement-breakpoint
CREATE TABLE "ticket_labels" (
	"ticket_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	CONSTRAINT "ticket_labels_ticket_id_label_id_pk" PRIMARY KEY("ticket_id","label_id")
);
--> statement-breakpoint
ALTER TABLE "decision_nodes" ADD CONSTRAINT "decision_nodes_team_fk" FOREIGN KEY ("team_id","workspace_id") REFERENCES "public"."teams"("id","workspace_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "decision_nodes" ADD CONSTRAINT "decision_nodes_decision_fk" FOREIGN KEY ("decision_id","team_id") REFERENCES "public"."decisions"("id","team_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "decision_nodes" ADD CONSTRAINT "decision_nodes_node_fk" FOREIGN KEY ("node_id","team_id") REFERENCES "public"."nodes"("id","team_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invite_teams" ADD CONSTRAINT "invite_teams_team_fk" FOREIGN KEY ("team_id","workspace_id") REFERENCES "public"."teams"("id","workspace_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invite_teams" ADD CONSTRAINT "invite_teams_invite_fk" FOREIGN KEY ("invite_id","workspace_id") REFERENCES "public"."invites"("id","workspace_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_team_fk" FOREIGN KEY ("team_id","workspace_id") REFERENCES "public"."teams"("id","workspace_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ticket_labels" ADD CONSTRAINT "ticket_labels_team_fk" FOREIGN KEY ("team_id","workspace_id") REFERENCES "public"."teams"("id","workspace_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ticket_labels" ADD CONSTRAINT "ticket_labels_ticket_fk" FOREIGN KEY ("ticket_id","team_id") REFERENCES "public"."tickets"("id","team_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ticket_labels" ADD CONSTRAINT "ticket_labels_label_fk" FOREIGN KEY ("label_id","team_id") REFERENCES "public"."labels"("id","team_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "decision_nodes_node_idx" ON "decision_nodes" USING btree ("node_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "labels_team_name_idx" ON "labels" USING btree ("team_id",lower("name"));
--> statement-breakpoint
CREATE INDEX "ticket_labels_label_idx" ON "ticket_labels" USING btree ("label_id");
--> statement-breakpoint
DO $$
DECLARE bad_nodes integer; bad_invites integer; bad_labels integer;
BEGIN
  SELECT count(*) INTO bad_nodes FROM decisions d, jsonb_array_elements(d.node_ids) e
    WHERE jsonb_typeof(e) <> 'string' OR (e #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id::text = lower(e #>> '{}') AND n.team_id = d.team_id);
  SELECT count(*) INTO bad_invites FROM invites i, jsonb_array_elements(i.teams) g
    WHERE i.workspace_id IS NULL OR jsonb_typeof(g->'teamId') <> 'string' OR (g->>'teamId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR (g->>'role') NOT IN ('admin', 'editor', 'viewer')
       OR NOT EXISTS (SELECT 1 FROM teams t WHERE t.id::text = lower(g->>'teamId') AND t.workspace_id = i.workspace_id);
  SELECT count(*) INTO bad_labels FROM tickets t, jsonb_array_elements(t.labels) e WHERE jsonb_typeof(e) <> 'string';
  IF bad_nodes + bad_invites + bad_labels > 0 THEN
    RAISE EXCEPTION 'WH-115: % decision node id(s), % invite team(s) and % ticket label(s) point at something that is not there or is not valid. Run pnpm db:preflight on this database, fix them by hand, and run the migration again. Nothing was changed.', bad_nodes, bad_invites, bad_labels;
  END IF;
END $$;
--> statement-breakpoint
INSERT INTO "decision_nodes" ("decision_id", "node_id", "team_id", "workspace_id")
SELECT DISTINCT d."id", lower(e)::uuid, d."team_id", d."workspace_id" FROM "decisions" d, jsonb_array_elements_text(d."node_ids") AS e;
--> statement-breakpoint
INSERT INTO "invite_teams" ("invite_id", "team_id", "workspace_id", "role")
SELECT DISTINCT ON (i."id", lower(g->>'teamId')) i."id", lower(g->>'teamId')::uuid, i."workspace_id", g->>'role' FROM "invites" i, jsonb_array_elements(i."teams") AS g ORDER BY i."id", lower(g->>'teamId');
--> statement-breakpoint
CREATE TEMP TABLE "_label_raw" AS
SELECT t."id" AS ticket_id, t."team_id", t."workspace_id", t."number", e.pos, regexp_replace(btrim(e.v), '\s+', ' ', 'g') AS name FROM "tickets" t, jsonb_array_elements_text(t."labels") WITH ORDINALITY AS e(v, pos);--> statement-breakpoint
INSERT INTO "labels" ("team_id", "workspace_id", "name")
SELECT DISTINCT ON (team_id, lower(name)) team_id, workspace_id, name FROM "_label_raw" WHERE name <> '' ORDER BY team_id, lower(name), number, pos;--> statement-breakpoint
INSERT INTO "ticket_labels" ("ticket_id", "label_id", "team_id", "workspace_id")
SELECT DISTINCT r.ticket_id, l."id", r.team_id, r.workspace_id FROM "_label_raw" r JOIN "labels" l ON l."team_id" = r.team_id AND lower(l."name") = lower(r.name) WHERE r.name <> '';--> statement-breakpoint
DROP TABLE "_label_raw";
--> statement-breakpoint
ALTER TABLE "decisions" DROP COLUMN "node_ids";
--> statement-breakpoint
ALTER TABLE "invites" DROP COLUMN "teams";
--> statement-breakpoint
ALTER TABLE "tickets" DROP COLUMN "labels";
