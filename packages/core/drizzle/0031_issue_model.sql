-- The Linear-style issue model: sub-issues, statuses that can share a role (one of them the role's default), a canceled role, and a
-- "no priority" that new issues start with. The parent key is written here because drizzle cannot say SET NULL on named columns.
ALTER TABLE "issues" DROP CONSTRAINT "issues_priority_check";--> statement-breakpoint
ALTER TABLE "statuses" DROP CONSTRAINT "statuses_role_check";--> statement-breakpoint
DROP INDEX "statuses_team_role_idx";--> statement-breakpoint
ALTER TABLE "issues" ALTER COLUMN "priority" SET DEFAULT 'none';--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "statuses" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Until now a team had one status per role, so each of those is its role's default.
UPDATE "statuses" SET "is_default" = true WHERE "role" IS NOT NULL;--> statement-breakpoint
-- Names become unique in a team whatever their case: a second "todo" next to "Todo" is renamed "todo (2)" rather than refused.
UPDATE "statuses" s SET "name" = s."name" || ' (' || d.rn || ')'
  FROM (SELECT "id", row_number() OVER (PARTITION BY "team_id", lower("name") ORDER BY "position", "id") AS rn FROM "statuses") d
  WHERE d."id" = s."id" AND d.rn > 1;--> statement-breakpoint
-- Every team gets a canceled status: a role-less one that is already called that becomes it; the others get a new one at the end.
UPDATE "statuses" s SET "role" = 'canceled', "is_default" = true
  WHERE s."role" IS NULL AND lower(s."name") IN ('canceled', 'cancelled')
    AND s."id" = (SELECT x."id" FROM "statuses" x WHERE x."team_id" = s."team_id" AND x."role" IS NULL AND lower(x."name") IN ('canceled', 'cancelled') ORDER BY x."position", x."id" LIMIT 1);--> statement-breakpoint
INSERT INTO "statuses" ("team_id", "workspace_id", "name", "position", "role", "is_default")
  SELECT t."id", t."workspace_id",
    CASE WHEN EXISTS (SELECT 1 FROM "statuses" x WHERE x."team_id" = t."id" AND lower(x."name") = 'canceled') THEN 'Canceled (status)' ELSE 'Canceled' END,
    COALESCE((SELECT max(x."position") FROM "statuses" x WHERE x."team_id" = t."id"), 0) + 1000, 'canceled', true
  FROM "teams" t
  WHERE NOT EXISTS (SELECT 1 FROM "statuses" x WHERE x."team_id" = t."id" AND x."role" = 'canceled');--> statement-breakpoint
CREATE INDEX "issues_parent_idx" ON "issues" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "statuses_team_default_role_idx" ON "statuses" USING btree ("team_id","role") WHERE is_default;--> statement-breakpoint
CREATE UNIQUE INDEX "statuses_team_name_idx" ON "statuses" USING btree ("team_id",lower("name"));--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_not_own_parent_check" CHECK ("parent_id" is distinct from "id");--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_priority_check" CHECK ("priority" in ('none', 'low', 'medium', 'high', 'urgent'));--> statement-breakpoint
ALTER TABLE "statuses" ADD CONSTRAINT "statuses_default_has_role_check" CHECK (not "is_default" or "role" is not null);--> statement-breakpoint
ALTER TABLE "statuses" ADD CONSTRAINT "statuses_role_check" CHECK ("role" in ('backlog', 'todo', 'in_progress', 'review', 'done', 'canceled'));--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_parent_fk" FOREIGN KEY ("parent_id","team_id") REFERENCES "issues"("id","team_id") ON DELETE SET NULL ("parent_id") ON UPDATE no action;
