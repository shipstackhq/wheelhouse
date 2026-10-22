-- A run on a device records the branch it starts from (picked in "Run on device"; the repository's default branch unless changed).
ALTER TABLE "device_jobs" ADD COLUMN "base_branch" text;