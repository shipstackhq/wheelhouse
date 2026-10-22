-- Every status has a role. The few that had none (a custom "Blocked", say) take the role of the nearest status before them in board
-- order, or of the first status when none comes before, so the stages stay in one run each and no status moves on the board. They are
-- not made a default: each role already has one.
UPDATE "statuses" s SET "role" = (
  SELECT x."role" FROM "statuses" x
  WHERE x."team_id" = s."team_id" AND x."role" IS NOT NULL AND (x."position" < s."position" OR (x."position" = s."position" AND x."id" < s."id"))
  ORDER BY x."position" DESC, x."id" DESC LIMIT 1
) WHERE s."role" IS NULL;--> statement-breakpoint
UPDATE "statuses" s SET "role" = (
  SELECT x."role" FROM "statuses" x WHERE x."team_id" = s."team_id" AND x."role" IS NOT NULL ORDER BY x."position" ASC, x."id" ASC LIMIT 1
) WHERE s."role" IS NULL;--> statement-breakpoint
ALTER TABLE "statuses" DROP CONSTRAINT "statuses_default_has_role_check";--> statement-breakpoint
ALTER TABLE "statuses" ALTER COLUMN "role" SET NOT NULL;
