ALTER TABLE "columns" ADD COLUMN "role" text;
--> statement-breakpoint
-- Existing boards were all created from the standard names, so give those columns their roles.
UPDATE "columns" SET "role" = CASE lower(trim("name"))
  WHEN 'backlog' THEN 'backlog'
  WHEN 'todo' THEN 'todo'
  WHEN 'in progress' THEN 'in_progress'
  WHEN 'review' THEN 'review'
  WHEN 'done' THEN 'done'
END WHERE "role" IS NULL;
