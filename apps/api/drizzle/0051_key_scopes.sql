ALTER TABLE "api_keys" ALTER COLUMN "capabilities" SET DEFAULT '["read","board:write","map:write"]'::jsonb;--> statement-breakpoint
UPDATE "api_keys" SET "capabilities" = CASE WHEN "capabilities" ? 'docs:write' THEN '["read","board:write","map:write","docs:write"]'::jsonb ELSE '["read","board:write","map:write"]'::jsonb END;
