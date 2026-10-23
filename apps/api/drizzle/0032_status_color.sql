-- A status can have a colour, and deleting a status no longer deletes the issues in it (they must be moved first).
ALTER TABLE "issues" DROP CONSTRAINT "issues_status_id_statuses_id_fk";
--> statement-breakpoint
ALTER TABLE "statuses" ADD COLUMN "color" text;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_status_id_statuses_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."statuses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statuses" ADD CONSTRAINT "statuses_color_check" CHECK ("color" in ('slate', 'sky', 'emerald', 'amber', 'rose', 'violet', 'teal', 'orange', 'fuchsia', 'lime', 'indigo'));