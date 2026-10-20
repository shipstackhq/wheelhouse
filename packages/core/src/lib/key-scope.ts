import { eq, sql } from "drizzle-orm";
import { schema } from "../db";
import type { Q } from "./service";

/**
 * Give a key every team its workspace has right now: what migration 0026 did to the keys that existed (WH-120). Later teams are
 * not added; a key that creates a team gets that one, and a person narrows or widens a key from the Agents page.
 */
export async function scopeKeyToAllTeams(q: Q, keyId: string, workspaceId: string) {
  await q.execute(sql`
    insert into api_key_teams (api_key_id, team_id, workspace_id)
    select ${keyId}, id, workspace_id from teams where workspace_id = ${workspaceId}
    on conflict do nothing`);
  return q.select({ teamId: schema.apiKeyTeams.teamId }).from(schema.apiKeyTeams).where(eq(schema.apiKeyTeams.apiKeyId, keyId));
}
