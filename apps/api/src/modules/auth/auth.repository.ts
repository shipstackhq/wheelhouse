import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { schema } from "../../db";
import type { TeamRole, WorkspaceRole } from "../../db/schema";
import { Database } from "../../platform/database/database";
import { newWorkspaceSlug } from "./workspaces/workspace-slug";

const { users, sessions, workspaces, memberships, invites, inviteTeams, apiKeys, apiKeyTeams, userGrants, userGrantWorkspaces, teams, teamMembers, auditEvents, events } = schema;

export type UserRow = typeof users.$inferSelect;
export type WorkspaceRowT = typeof workspaces.$inferSelect;
export type MembershipRow = typeof memberships.$inferSelect;
export type InviteRow = typeof invites.$inferSelect;
export type KeyRow = typeof apiKeys.$inferSelect;
export type AuditInsert = typeof auditEvents.$inferInsert;

/** Which invites a person may see or revoke: a workspace's join invites (`joinWorkspaceId`) and/or new-workspace invites (`newWorkspaces`). */
export type InviteScope = { joinWorkspaceId?: string; newWorkspaces?: boolean };

/**
 * Every query on the auth module's tables (users, sessions, workspaces, memberships, invites, invite teams, API keys and their team
 * scopes, and the access audit log), and the only file of the module that touches Drizzle. Each method reads `this.db.q`, so it runs on
 * the current transaction when a service opened one. It decides nothing: the rules are in the services and in auth.rules.ts.
 * Every statement about a person's own workspace is scoped by the workspace id the caller passes in, so another workspace's rows match
 * nothing.
 */
@Injectable()
export class AuthRepository {
  constructor(@Inject(Database) private readonly db: Database) {}

  // ───────── users ─────────

  async userCount(): Promise<number> {
    const [{ n }] = await this.db.q.select({ n: sql<number>`count(*)::int` }).from(users);
    return n;
  }

  async userByEmail(email: string): Promise<UserRow | undefined> {
    const [u] = await this.db.q.select().from(users).where(eq(users.email, email));
    return u;
  }

  async userName(id: string): Promise<string | undefined> {
    const [u] = await this.db.q.select({ name: users.name }).from(users).where(eq(users.id, id));
    return u?.name;
  }

  async userContact(id: string): Promise<{ name: string; email: string } | undefined> {
    const [u] = await this.db.q.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, id));
    return u;
  }

  async insertUser(v: { email: string; name: string; passwordHash: string }): Promise<UserRow> {
    const [u] = await this.db.q.insert(users).values(v).returning();
    return u;
  }

  async setPasswordHash(userId: string, passwordHash: string) {
    await this.db.q.update(users).set({ passwordHash }).where(eq(users.id, userId));
  }

  // ───────── sessions ─────────

  /** The workspaces a person belongs to, as their suspension flags (a person is locked out only when every one is suspended). */
  suspensionsOf(userId: string) {
    return this.db.q
      .select({ at: workspaces.suspendedAt })
      .from(memberships)
      .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
      .where(eq(memberships.userId, userId));
  }

  /** A live session by the sha256 of its cookie token, with the user and the workspace the session chose. */
  async sessionRow(tokenHash: string, now: Date) {
    const [row] = await this.db.q
      .select({ user: users, activeWorkspaceId: sessions.activeWorkspaceId })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.id, tokenHash), gt(sessions.expiresAt, now)));
    return row;
  }

  async insertSession(id: string, userId: string, expiresAt: Date) {
    await this.db.q.insert(sessions).values({ id, userId, expiresAt });
  }

  async deleteSession(id: string) {
    await this.db.q.delete(sessions).where(eq(sessions.id, id));
  }

  async setActiveWorkspace(tokenHash: string, userId: string, workspaceId: string) {
    await this.db.q.update(sessions).set({ activeWorkspaceId: workspaceId }).where(and(eq(sessions.id, tokenHash), eq(sessions.userId, userId)));
  }

  /** Ends every session of the workspace's members (suspending it). Returns the ids that ended. */
  deleteSessionsOfWorkspace(workspaceId: string) {
    const members = this.db.q.select({ id: memberships.userId }).from(memberships).where(eq(memberships.workspaceId, workspaceId));
    return this.db.q.delete(sessions).where(inArray(sessions.userId, members)).returning({ id: sessions.id });
  }

  // ───────── workspaces and memberships ─────────

  /** Every workspace the person is in, with the membership, oldest membership first. Suspended ones included: the caller filters. */
  membershipsOf(userId: string) {
    return this.db.q
      .select({ membership: memberships, workspace: workspaces })
      .from(memberships)
      .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
      .where(eq(memberships.userId, userId))
      .orderBy(memberships.createdAt);
  }

  async membershipIn(userId: string, workspaceId: string) {
    const [m] = await this.db.q
      .select({ workspace: workspaces })
      .from(memberships)
      .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
      .where(and(eq(memberships.userId, userId), eq(memberships.workspaceId, workspaceId)));
    return m;
  }

  async membershipExists(workspaceId: string, userId: string): Promise<boolean> {
    const [row] = await this.db.q.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)));
    return !!row;
  }

  async membershipRole(workspaceId: string, userId: string): Promise<{ role: WorkspaceRole } | undefined> {
    const [row] = await this.db.q
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)));
    return row;
  }

  /** Merges `patch` into the workspace's settings. */
  async mergeSettings(workspaceId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    const [row] = await this.db.q
      .update(schema.workspaces)
      .set({ settings: sql`${schema.workspaces.settings} || ${JSON.stringify(patch)}::jsonb` })
      .where(eq(schema.workspaces.id, workspaceId))
      .returning({ settings: schema.workspaces.settings });
    return row.settings;
  }

  async setPendingOwner(workspaceId: string, userId: string | null) {
    await this.db.q.update(workspaces).set({ pendingOwnerId: userId }).where(eq(workspaces.id, workspaceId));
  }

  /** Makes `userId` the one owner: every other owner becomes an admin. */
  async moveOwnership(workspaceId: string, userId: string) {
    await this.db.q.update(memberships).set({ role: "admin" }).where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, "owner")));
    await this.db.q.update(memberships).set({ role: "owner" }).where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)));
  }

  async ownerCount(workspaceId: string): Promise<number> {
    const [{ n }] = await this.db.q
      .select({ n: sql<number>`count(*)::int` })
      .from(memberships)
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, "owner")));
    return Number(n);
  }

  async memberCount(workspaceId: string): Promise<number> {
    const [r] = await this.db.q.select({ n: sql<number>`count(*)::int` }).from(memberships).where(eq(memberships.workspaceId, workspaceId));
    return r.n;
  }

  /** The people of a workspace with their memberships, oldest first. */
  membersOf(workspaceId: string) {
    return this.db.q
      .select({ user: users, m: memberships })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.workspaceId, workspaceId))
      .orderBy(memberships.createdAt);
  }

  /** Returns the rows it changed (the caller tests the length). */
  updateMembership(workspaceId: string, userId: string, role: WorkspaceRole, tags: string[]) {
    return this.db.q
      .update(memberships)
      .set({ role, tags })
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
      .returning({ userId: memberships.userId });
  }

  async deleteMembership(workspaceId: string, userId: string) {
    await this.db.q.delete(memberships).where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)));
  }

  async insertMembership(v: { userId: string; workspaceId: string; role: WorkspaceRole; tags?: string[] }) {
    await this.db.q.insert(memberships).values(v);
  }

  /** Every membership of every workspace, with the person's name and email (the instance admin's list). */
  allMemberships() {
    return this.db.q
      .select({ workspaceId: memberships.workspaceId, role: memberships.role, name: users.name, email: users.email })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId));
  }

  allMembershipUserWorkspaces() {
    return this.db.q.select({ userId: memberships.userId, workspaceId: memberships.workspaceId }).from(memberships);
  }

  allWorkspaces() {
    return this.db.q.select().from(workspaces).orderBy(workspaces.createdAt);
  }

  async workspaceById(id: string): Promise<WorkspaceRowT | undefined> {
    const [w] = await this.db.q.select().from(workspaces).where(eq(workspaces.id, id));
    return w;
  }

  /** The workspace row, locked until the transaction ends. */
  async lockWorkspace(id: string): Promise<WorkspaceRowT | undefined> {
    const [w] = await this.db.q.select().from(workspaces).where(eq(workspaces.id, id)).for("update");
    return w;
  }

  async suspendWorkspaceRow(id: string, v: { suspendedAt: Date; suspendedBy: string; suspendedReason: string | null }) {
    await this.db.q.update(workspaces).set(v).where(eq(workspaces.id, id));
  }

  /** Clears the suspension. Returns the rows it changed (the caller tests the length). */
  restoreWorkspaceRow(id: string) {
    return this.db.q
      .update(workspaces)
      .set({ suspendedAt: null, suspendedBy: null, suspendedReason: null })
      .where(and(eq(workspaces.id, id), isNotNull(workspaces.suspendedAt)))
      .returning({ id: workspaces.id });
  }

  /** A new workspace; the slug comes from the name unless one is given (the caller has checked it with `slugProblem` and `slugTaken`). */
  async insertWorkspace(name: string, kind: "personal" | "team" = "team", slug?: string): Promise<WorkspaceRowT> {
    const [w] = await this.db.q.insert(workspaces).values({ name, kind, slug: slug ?? (await newWorkspaceSlug(name, (s) => this.slugTaken(s))) }).returning();
    return w;
  }

  /** A personal workspace becomes a team one when someone else joins it. */
  async markTeam(workspaceId: string) {
    await this.db.q.update(workspaces).set({ kind: "team" }).where(and(eq(workspaces.id, workspaceId), eq(workspaces.kind, "personal")));
  }

  async slugTaken(slug: string): Promise<boolean> {
    const [taken] = await this.db.q.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.slug, slug));
    return !!taken;
  }

  /** The workspace's join invites still pending, by workspace: the admin's seat counts. */
  pendingJoinCounts(now: Date) {
    return this.db.q
      .select({ workspaceId: invites.workspaceId, n: sql<number>`count(*)::int` })
      .from(invites)
      .where(and(eq(invites.kind, "join_workspace"), pendingInvite(now)))
      .groupBy(invites.workspaceId);
  }

  teamCounts() {
    return this.db.q.select({ workspaceId: teams.workspaceId, n: sql<number>`count(*)::int` }).from(teams).groupBy(teams.workspaceId);
  }

  lastEventAts() {
    return this.db.q.select({ workspaceId: events.workspaceId, at: sql<string | null>`max(${events.createdAt})` }).from(events).groupBy(events.workspaceId);
  }

  lastKeyUses() {
    return this.db.q.select({ workspaceId: apiKeys.workspaceId, at: sql<string | null>`max(${apiKeys.lastUsedAt})` }).from(apiKeys).groupBy(apiKeys.workspaceId);
  }

  /** Who sent the new-workspace invite each founder used. */
  founderInvites() {
    return this.db.q
      .select({ usedBy: invites.usedBy, name: users.name, email: users.email })
      .from(invites)
      .innerJoin(users, eq(users.id, invites.createdBy))
      .where(and(eq(invites.kind, "new_workspace"), isNotNull(invites.usedBy)));
  }

  /** A workspace's invites, and those used by its members, newest first. */
  invitesTouching(workspaceId: string, memberIds: string[]) {
    return this.db.q
      .select()
      .from(invites)
      .where(memberIds.length ? or(eq(invites.workspaceId, workspaceId), inArray(invites.usedBy, memberIds)) : eq(invites.workspaceId, workspaceId))
      .orderBy(desc(invites.createdAt));
  }

  // ───────── team scopes of a person's access (the admin list and the removal) ─────────

  /** The teams a person is an admin of, in one workspace. */
  teamsAdminOf(workspaceId: string, userId: string) {
    return this.db.q
      .select({ id: teamMembers.teamId, key: teams.key })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(and(eq(teamMembers.workspaceId, workspaceId), eq(teamMembers.userId, userId), eq(teamMembers.role, "admin")));
  }

  /** The admins other than `userId` of the given teams. */
  adminsOtherThan(teamIds: string[], userId: string) {
    return this.db.q
      .select({ id: teamMembers.teamId })
      .from(teamMembers)
      .where(and(inArray(teamMembers.teamId, teamIds), eq(teamMembers.role, "admin"), sql`${teamMembers.userId} <> ${userId}`));
  }

  async deleteTeamMembershipsOf(workspaceId: string, userId: string) {
    await this.db.q.delete(teamMembers).where(and(eq(teamMembers.workspaceId, workspaceId), eq(teamMembers.userId, userId)));
  }

  /** A team of the workspace, if it is one. */
  async teamInWorkspace(teamId: string, workspaceId: string): Promise<{ id: string } | undefined> {
    const [p] = await this.db.q.select({ id: teams.id }).from(teams).where(and(eq(teams.id, teamId), eq(teams.workspaceId, workspaceId)));
    return p;
  }

  async addTeamMember(v: { teamId: string; userId: string; workspaceId: string; role: TeamRole; addedBy: string | null }) {
    await this.db.q.insert(teamMembers).values(v).onConflictDoNothing();
  }

  // ───────── the access audit log ─────────

  async insertAudit(v: AuditInsert) {
    await this.db.q.insert(auditEvents).values(v);
  }

  // ───────── invites ─────────

  async pendingInviteByTokenHash(tokenHash: string, now: Date): Promise<InviteRow | undefined> {
    const [row] = await this.db.q.select().from(invites).where(and(eq(invites.tokenHash, tokenHash), pendingInvite(now)));
    return row;
  }

  /** Pending duplicates of an invite to one address: in the workspace for a join invite, among the new-workspace ones otherwise. */
  async duplicatePendingInvite(kind: "new_workspace" | "join_workspace", email: string, workspaceId: string | null, now: Date) {
    const scope = workspaceId ? eq(invites.workspaceId, workspaceId) : isNull(invites.workspaceId);
    const [dup] = await this.db.q
      .select({ id: invites.id })
      .from(invites)
      .where(and(eq(invites.kind, kind), eq(invites.email, email), scope, pendingInvite(now)));
    return dup;
  }

  async insertInvite(v: typeof invites.$inferInsert): Promise<{ id: string }> {
    const [r] = await this.db.q.insert(invites).values(v).returning({ id: invites.id });
    return r;
  }

  async insertInviteTeams(rows: { inviteId: string; teamId: string; workspaceId: string; role: TeamRole }[]) {
    await this.db.q.insert(inviteTeams).values(rows);
  }

  /** The pending invites within a scope (see `InviteScope`), oldest first, without their teams. */
  pendingInvitesIn(scope: InviteScope, now: Date) {
    return this.db.q
      .select({
        id: invites.id,
        kind: invites.kind,
        email: invites.email,
        role: invites.role,
        workspaceName: invites.workspaceName,
        createdAt: invites.createdAt,
        expiresAt: invites.expiresAt,
      })
      .from(invites)
      .where(and(pendingInvite(now), inScope(scope)))
      .orderBy(invites.createdAt);
  }

  /** The teams each of these invites adds a person to, by team key. */
  grantedTeams(inviteIds: string[]) {
    return this.db.q
      .select({ inviteId: inviteTeams.inviteId, key: teams.key, name: teams.name, role: inviteTeams.role })
      .from(inviteTeams)
      .innerJoin(teams, eq(teams.id, inviteTeams.teamId))
      .where(inArray(inviteTeams.inviteId, inviteIds))
      .orderBy(teams.key);
  }

  /** The invite is revoked if it is still pending and in the scope. Returns the rows it changed. */
  revokeInviteRow(id: string, now: Date, scope: InviteScope) {
    return this.db.q
      .update(invites)
      .set({ revokedAt: now })
      .where(and(eq(invites.id, id), isNull(invites.usedAt), isNull(invites.revokedAt), inScope(scope)))
      .returning({ id: invites.id });
  }

  /** Claims the invite: succeeds for exactly one caller, whatever the concurrency. Returns the rows it changed. */
  claimInvite(id: string, now: Date, usedBy?: string) {
    const set = usedBy === undefined ? { usedAt: now } : { usedAt: now, usedBy };
    return this.db.q
      .update(invites)
      .set(set)
      .where(and(eq(invites.id, id), pendingInvite(now)))
      .returning({ id: invites.id });
  }

  async setInviteUsedBy(id: string, userId: string) {
    await this.db.q.update(invites).set({ usedBy: userId }).where(eq(invites.id, id));
  }

  /** The teams an invite grants, one row per team. */
  inviteGrants(inviteId: string) {
    return this.db.q.select().from(inviteTeams).where(eq(inviteTeams.inviteId, inviteId));
  }

  async pendingJoinCount(workspaceId: string, now: Date): Promise<number> {
    const [r] = await this.db.q
      .select({ n: sql<number>`count(*)::int` })
      .from(invites)
      .where(and(eq(invites.kind, "join_workspace"), eq(invites.workspaceId, workspaceId), pendingInvite(now)));
    return r.n;
  }

  // ───────── API keys ─────────

  /** The key by the sha256 of its secret, if it is not revoked, with its workspace's suspension. */
  async activeKeyByHash(keyHash: string) {
    const [row] = await this.db.q
      .select({ key: apiKeys, suspendedAt: workspaces.suspendedAt })
      .from(apiKeys)
      .innerJoin(workspaces, eq(workspaces.id, apiKeys.workspaceId))
      .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt), or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date()))));
    return row;
  }

  /** The device grant by the sha256 of its token. A revoked grant is never returned. */
  async activeGrantByHash(tokenHash: string) {
    const [row] = await this.db.q.select().from(userGrants).where(and(eq(userGrants.tokenHash, tokenHash), isNull(userGrants.revokedAt)));
    return row;
  }

  /** The workspace ids a chosen-list grant reaches (empty for an all-workspaces grant). */
  async grantWorkspaceIds(grantId: string): Promise<string[]> {
    const rows = await this.db.q.select({ id: userGrantWorkspaces.workspaceId }).from(userGrantWorkspaces).where(eq(userGrantWorkspaces.grantId, grantId));
    return rows.map((r) => r.id);
  }

  async touchKey(id: string, at: Date) {
    await this.db.q.update(apiKeys).set({ lastUsedAt: at }).where(eq(apiKeys.id, id));
  }

  keysOf(workspaceId: string): Promise<KeyRow[]> {
    return this.db.q.select().from(apiKeys).where(and(eq(apiKeys.workspaceId, workspaceId), isNull(apiKeys.chatMessageId))).orderBy(desc(apiKeys.createdAt));
  }

  async keyIn(id: string, workspaceId: string): Promise<KeyRow | undefined> {
    const [key] = await this.db.q.select().from(apiKeys).where(and(eq(apiKeys.id, id), eq(apiKeys.workspaceId, workspaceId)));
    return key;
  }

  async insertKey(v: typeof apiKeys.$inferInsert): Promise<KeyRow> {
    const [k] = await this.db.q.insert(apiKeys).values(v).returning();
    return k;
  }

  async setKeyCapabilities(id: string, workspaceId: string, capabilities: string[]): Promise<KeyRow> {
    const [row] = await this.db.q.update(apiKeys).set({ capabilities }).where(and(eq(apiKeys.id, id), eq(apiKeys.workspaceId, workspaceId))).returning();
    return row;
  }

  /** Revokes the key if it is the workspace's. Returns the rows it changed. */
  revokeKey(workspaceId: string, keyId: string) {
    return this.db.q
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.workspaceId, workspaceId)))
      .returning({ id: apiKeys.id });
  }

  /** The keys' teams, each row with its key id, by team key. */
  keyTeams(keyIds: string[]) {
    return this.db.q
      .select({ keyId: apiKeyTeams.apiKeyId, key: teams.key, name: teams.name })
      .from(apiKeyTeams)
      .innerJoin(teams, eq(teams.id, apiKeyTeams.teamId))
      .where(inArray(apiKeyTeams.apiKeyId, keyIds))
      .orderBy(asc(teams.key));
  }

  async keyTeamIds(keyId: string): Promise<string[]> {
    const rows = await this.db.q.select({ id: apiKeyTeams.teamId }).from(apiKeyTeams).where(eq(apiKeyTeams.apiKeyId, keyId));
    return rows.map((r) => r.id);
  }

  async deleteKeyTeams(keyId: string, teamIds: string[]) {
    await this.db.q.delete(apiKeyTeams).where(and(eq(apiKeyTeams.apiKeyId, keyId), inArray(apiKeyTeams.teamId, teamIds)));
  }

  async insertKeyTeams(rows: { apiKeyId: string; teamId: string; workspaceId: string }[]) {
    await this.db.q.insert(apiKeyTeams).values(rows);
  }

  /** The teams (id and key) among these ids. */
  teamsByIds(ids: string[]) {
    return this.db.q.select({ id: teams.id, key: teams.key }).from(teams).where(inArray(teams.id, ids));
  }

  /**
   * Gives a key every team its workspace has right now (what migration 0026 did): the insert takes the teams by the workspace id, so it
   * only ever names the key's own workspace. Returns the key's team rows.
   */
  async scopeKeyToAllTeams(keyId: string, workspaceId: string) {
    await this.db.q.execute(sql`
    insert into api_key_teams (api_key_id, team_id, workspace_id)
    select ${keyId}, id, workspace_id from teams where workspace_id = ${workspaceId}
    on conflict do nothing`);
    return this.db.q.select({ teamId: apiKeyTeams.teamId }).from(apiKeyTeams).where(eq(apiKeyTeams.apiKeyId, keyId));
  }
}

/** Pending: not used, not revoked, not expired. */
function pendingInvite(now: Date) {
  return and(isNull(invites.usedAt), isNull(invites.revokedAt), gt(invites.expiresAt, now));
}

/** The invites a scope covers: a workspace's join invites and/or the new-workspace ones. Empty scope matches nothing. */
function inScope(scope: InviteScope) {
  const parts = [];
  if (scope.joinWorkspaceId) parts.push(and(eq(invites.kind, "join_workspace"), eq(invites.workspaceId, scope.joinWorkspaceId)));
  if (scope.newWorkspaces) parts.push(eq(invites.kind, "new_workspace"));
  return parts.length ? or(...parts) : sql`false`;
}
