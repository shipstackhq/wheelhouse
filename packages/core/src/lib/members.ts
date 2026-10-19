import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "../db";
import { isUuid } from "./project-access";
import { ServiceError } from "./service-error";
import type { WorkspaceRole } from "../db/schema";

/**
 * Team membership and API-key changes made by a team owner. Every statement is scoped by `teamId`, so a user id
 * or key id from another team matches nothing. Each returns whether a row changed, which is what the isolation
 * tests assert on.
 */

/** Change a member's role and tags. Refuses to demote the only owner. A change of role is written to the access audit log. */
export async function updateMember(teamId: string, actingUserId: string, input: { userId: string; role: WorkspaceRole; tags: string[] }) {
  if (!isUuid(input.userId)) return false;
  const db = await getDb();
  if (input.userId === actingUserId && input.role !== "owner") {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.teamId, teamId), eq(schema.memberships.role, "owner")));
    if (Number(n) <= 1) return false; // keep at least one owner
  }
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({ role: schema.memberships.role })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.teamId, teamId), eq(schema.memberships.userId, input.userId)));
    const rows = await tx
      .update(schema.memberships)
      .set({ role: input.role, tags: input.tags })
      .where(and(eq(schema.memberships.teamId, teamId), eq(schema.memberships.userId, input.userId)))
      .returning({ userId: schema.memberships.userId });
    if (rows.length && before && before.role !== input.role) {
      const [actor] = await tx.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, actingUserId));
      await tx.insert(schema.auditEvents).values({
        teamId,
        actorKind: "human",
        actorId: actingUserId,
        actorName: actor?.name ?? "Someone",
        action: "workspace.role_changed",
        targetType: "user",
        targetId: input.userId,
        before: { role: before.role },
        after: { role: input.role },
      });
    }
    return rows.length > 0;
  });
}

/**
 * Removes the person from the workspace and from every project of it. A project must keep one admin (ADR-23), so someone who is
 * the only admin of a project cannot be removed until another admin is named; the error says which projects.
 */
export async function removeMember(teamId: string, actingUserId: string, userId: string) {
  if (userId === actingUserId || !isUuid(userId)) return false;
  const db = await getDb();
  const { projectMembers: pm, projects } = schema;
  return db.transaction(async (tx) => {
    const [exists] = await tx
      .select({ userId: schema.memberships.userId })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.teamId, teamId), eq(schema.memberships.userId, userId)));
    if (!exists) return false;
    const adminOf = await tx
      .select({ id: pm.projectId, key: projects.key })
      .from(pm)
      .innerJoin(projects, eq(projects.id, pm.projectId))
      .where(and(eq(pm.teamId, teamId), eq(pm.userId, userId), eq(pm.role, "admin")));
    if (adminOf.length) {
      const others = await tx
        .select({ id: pm.projectId })
        .from(pm)
        .where(and(inArray(pm.projectId, adminOf.map((p) => p.id)), eq(pm.role, "admin"), sql`${pm.userId} <> ${userId}`));
      const covered = new Set(others.map((o) => o.id));
      const stranded = adminOf.filter((p) => !covered.has(p.id)).map((p) => p.key);
      if (stranded.length) {
        throw new ServiceError("conflict", `They are the only admin of ${stranded.join(", ")}. Name another project admin first.`, { projects: stranded });
      }
    }
    await tx.delete(pm).where(and(eq(pm.teamId, teamId), eq(pm.userId, userId)));
    await tx.delete(schema.memberships).where(and(eq(schema.memberships.teamId, teamId), eq(schema.memberships.userId, userId)));
    const [actor] = await tx.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, actingUserId));
    await tx.insert(schema.auditEvents).values({
      teamId,
      actorKind: "human",
      actorId: actingUserId,
      actorName: actor?.name ?? "Someone",
      action: "workspace.member_removed",
      targetType: "user",
      targetId: userId,
    });
    return true;
  });
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
