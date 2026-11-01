ALTER TABLE "repositories" ADD COLUMN "checks" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
UPDATE "repositories" SET "checks" = '[{"name":"install","command":"pnpm install --frozen-lockfile","required":true},{"name":"lint","command":"pnpm lint","required":true},{"name":"typecheck","command":"pnpm typecheck","required":true},{"name":"migrations","command":"pnpm db:generate && test -z \"$(git status --porcelain apps/api/drizzle)\"","required":true}]'::jsonb WHERE "github_full_name" = 'shipstackhq/wheelhouse';
