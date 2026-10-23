-- A4, A5, A8, A10 (WH-114): unique keys first, then the parent keys that use them, then the CHECKs. Run `pnpm db:preflight` on a copy of the real data first: any row that breaks one of these makes the statement fail.
ALTER TABLE "docs" ADD CONSTRAINT "docs_id_team_unique" UNIQUE("id","team_id");--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_id_team_unique" UNIQUE("id","team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "columns_team_role_idx" ON "columns" USING btree ("team_id","role") WHERE role is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "teams_workspace_key_idx" ON "teams" USING btree ("workspace_id",lower("key"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_idx" ON "users" USING btree (lower("email"));--> statement-breakpoint
ALTER TABLE "docs" ADD CONSTRAINT "docs_parent_fk" FOREIGN KEY ("parent_id","team_id") REFERENCES "public"."docs"("id","team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_parent_fk" FOREIGN KEY ("parent_id","team_id") REFERENCES "public"."nodes"("id","team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_kind_check" CHECK ("actor_kind" in ('human', 'agent'));--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_target_type_check" CHECK ("target_type" in ('user', 'team', 'membership'));--> statement-breakpoint
ALTER TABLE "columns" ADD CONSTRAINT "columns_role_check" CHECK ("role" in ('backlog', 'todo', 'in_progress', 'review', 'done'));--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_kind_check" CHECK ("author_kind" in ('human', 'agent'));--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_status_check" CHECK ("status" in ('proposed', 'accepted', 'superseded', 'rejected'));--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_author_kind_check" CHECK ("author_kind" in ('human', 'agent'));--> statement-breakpoint
ALTER TABLE "doc_drafts" ADD CONSTRAINT "doc_drafts_author_kind_check" CHECK ("author_kind" in ('human', 'agent'));--> statement-breakpoint
ALTER TABLE "doc_drafts" ADD CONSTRAINT "doc_drafts_status_check" CHECK ("status" in ('pending', 'published', 'discarded'));--> statement-breakpoint
ALTER TABLE "docs" ADD CONSTRAINT "docs_created_by_kind_check" CHECK ("created_by_kind" in ('human', 'agent'));--> statement-breakpoint
ALTER TABLE "docs" ADD CONSTRAINT "docs_updated_by_kind_check" CHECK ("updated_by_kind" in ('human', 'agent'));--> statement-breakpoint
ALTER TABLE "docs" ADD CONSTRAINT "docs_stale_source_check" CHECK ("stale_source" in ('report', 'drift'));--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_kind_check" CHECK ("kind" in ('depends', 'implements', 'references'));--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_actor_kind_check" CHECK ("actor_kind" in ('human', 'agent'));--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_entity_check" CHECK ("entity" in ('ticket', 'comment', 'node', 'edge', 'column', 'team', 'flow', 'decision', 'term', 'doc'));--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_kind_check" CHECK ("kind" in ('new_workspace', 'join_workspace'));--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_role_check" CHECK ("role" in ('owner', 'admin', 'member', 'viewer', 'guest'));--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_role_check" CHECK ("role" in ('owner', 'admin', 'member', 'viewer', 'guest'));--> statement-breakpoint
ALTER TABLE "node_drafts" ADD CONSTRAINT "node_drafts_author_kind_check" CHECK ("author_kind" in ('human', 'agent'));--> statement-breakpoint
ALTER TABLE "node_drafts" ADD CONSTRAINT "node_drafts_status_check" CHECK ("status" in ('pending', 'published', 'discarded'));--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_layer_check" CHECK ("layer" in ('concept', 'system', 'data', 'code'));--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_kind_check" CHECK ("kind" in ('concept', 'capability', 'actor', 'service', 'module', 'component', 'database', 'queue', 'external', 'table', 'view', 'enum', 'directory', 'file', 'symbol', 'endpoint'));--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_stale_source_check" CHECK ("stale_source" in ('report', 'drift'));--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_status_check" CHECK ("status" in ('planned', 'building', 'live', 'deprecated'));--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_state_check" CHECK ("state" in ('open', 'closed', 'merged'));--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_ci_state_check" CHECK ("ci_state" in ('success', 'failure', 'pending'));--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_provider_check" CHECK ("provider" in ('github', 'local'));--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_lifecycle_check" CHECK ("lifecycle" in ('live', 'being_replaced', 'planned', 'retired'));--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_role_check" CHECK ("role" in ('admin', 'editor', 'viewer'));--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_priority_check" CHECK ("priority" in ('low', 'medium', 'high', 'urgent'));--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_created_by_kind_check" CHECK ("created_by_kind" in ('human', 'agent'));
