-- WH-117: a team's cycles, and a ticket's cycle. The key from tickets is written here because drizzle cannot say SET NULL on one column.
CREATE TABLE "cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"goal" text DEFAULT '' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"rolled_over_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cycles_id_team_unique" UNIQUE("id","team_id"),
	CONSTRAINT "cycles_window_check" CHECK ("ends_at" > "starts_at")
);
--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_entity_check";--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "cycle_id" uuid;--> statement-breakpoint
ALTER TABLE "cycles" ADD CONSTRAINT "cycles_team_fk" FOREIGN KEY ("team_id","workspace_id") REFERENCES "public"."teams"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cycles_team_number_idx" ON "cycles" USING btree ("team_id","number");--> statement-breakpoint
CREATE INDEX "cycles_team_starts_idx" ON "cycles" USING btree ("team_id","starts_at");--> statement-breakpoint
CREATE INDEX "tickets_cycle_idx" ON "tickets" USING btree ("cycle_id");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_entity_check" CHECK ("entity" in ('ticket', 'comment', 'node', 'edge', 'column', 'team', 'flow', 'decision', 'term', 'doc', 'cycle'));--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_cycle_fk" FOREIGN KEY ("cycle_id","team_id") REFERENCES "public"."cycles"("id","team_id") ON DELETE SET NULL ("cycle_id") ON UPDATE no action;
