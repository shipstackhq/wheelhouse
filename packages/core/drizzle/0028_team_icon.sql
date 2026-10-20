ALTER TABLE "teams" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "icon_color" text;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_icon_color_check" CHECK ("icon_color" in ('slate', 'sky', 'emerald', 'amber', 'rose', 'violet', 'teal', 'orange', 'fuchsia', 'lime', 'indigo'));