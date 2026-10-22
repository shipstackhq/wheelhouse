-- Custom pictures (WH-126): the object-storage key of a person's profile picture and of a workspace's image.
ALTER TABLE "users" ADD COLUMN "avatar_key" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "image_key" text;
