ALTER TABLE "github_installations" DROP CONSTRAINT "github_installations_pkey";--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_installation_id_workspace_id_pk" PRIMARY KEY("installation_id","workspace_id");
