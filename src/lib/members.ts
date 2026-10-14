import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";

/**
 * Team membership and API-key changes made by a team owner. Every statement is scoped by `teamId`, so a user id
 * or key id from another team matches nothing. Each returns whether a row changed, which is what the isolation
 * tests assert on.
 */

/** Change a member's role and tags. Refuses to demote the only owner. */
export async function updateMember(teamId: string, actingUserId: string, input: { userId: string; role: "owner" | "member"; tags: string[] }) {
  const db = await getDb();
  if (input.userId === actingUserId && input.role !== "owner") {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.teamId, teamId), eq(schema.memberships.role, "owner")));
    if (Number(n) <= 1) return false; // keep at least one owner
  }
  const rows = await db
    .update(schema.memberships)
    .set({ role: input.role, tags: input.tags })
    .where(and(eq(schema.memberships.teamId, teamId), eq(schema.memberships.userId, input.userId)))
    .returning({ userId: schema.memberships.userId });
  return rows.length > 0;
}

export async function removeMember(teamId: string, actingUserId: string, userId: string) {
  if (userId === actingUserId) return false;
  const db = await getDb();
  const rows = await db
    .delete(schema.memberships)
    .where(and(eq(schema.memberships.teamId, teamId), eq(schema.memberships.userId, userId)))
    .returning({ userId: schema.memberships.userId });
  return rows.length > 0;
}

export async function revokeApiKey(teamId: string, keyId: string) {
  const db = await getDb();
  const rows = await db
    .update(schema.apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.apiKeys.id, keyId), eq(schema.apiKeys.teamId, teamId)))
    .returning({ id: schema.apiKeys.id });
  return rows.length > 0;
}
