CREATE TABLE "user_grant_workspaces" (
	"grant_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "user_grant_workspaces_grant_id_workspace_id_pk" PRIMARY KEY("grant_id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "user_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_name" text NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"all_workspaces" boolean DEFAULT false NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_grants_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "user_grants_id_user_id_unique" UNIQUE("id","user_id")
);
--> statement-breakpoint
ALTER TABLE "user_grant_workspaces" ADD CONSTRAINT "user_grant_workspaces_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_grant_workspaces" ADD CONSTRAINT "user_grant_workspaces_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_grant_workspaces" ADD CONSTRAINT "user_grant_workspaces_grant_fk" FOREIGN KEY ("grant_id","user_id") REFERENCES "public"."user_grants"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_grant_workspaces" ADD CONSTRAINT "user_grant_workspaces_membership_fk" FOREIGN KEY ("user_id","workspace_id") REFERENCES "public"."memberships"("user_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_grants" ADD CONSTRAINT "user_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_grant_workspaces_workspace_idx" ON "user_grant_workspaces" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "user_grants_user_idx" ON "user_grants" USING btree ("user_id");