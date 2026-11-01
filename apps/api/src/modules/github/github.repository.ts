import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { schema } from "../../db";
import { Database } from "../../platform/database/database";

const { githubDeliveries, githubInstallations, memberships, teams, pullRequests, pullRequestIssues, repositories, issues, statuses, events } = schema;

export type RepositoryRow = typeof repositories.$inferSelect;
export type RepositoryInsert = typeof repositories.$inferInsert;
export type InstallationRow = typeof githubInstallations.$inferSelect;
export type PullRequestRow = typeof pullRequests.$inferSelect;
export type PullRequestInsert = typeof pullRequests.$inferInsert;

/**
 * Every query on the github area's tables (repositories, github_installations, github_deliveries, pull_requests, pull_request_issues,
 * and the reads a delivery needs from memberships, teams, issues, statuses and the event log), and the only file in the module that
 * touches Drizzle. Each method reads `this.db.q`. It decides nothing: the rules are in the services.
 */
@Injectable()
export class GithubRepository {
  constructor(@Inject(Database) private readonly db: Database) {}

  // ───────── memberships ─────────

  async membershipRole(userId: string, workspaceId: string) {
    const [m] = await this.db.q.select({ role: memberships.role }).from(memberships).where(and(eq(memberships.userId, userId), eq(memberships.workspaceId, workspaceId)));
    return m?.role;
  }

  // ───────── repositories ─────────

  listRepositories(teamId: string) {
    return this.db.q.select().from(repositories).where(eq(repositories.teamId, teamId)).orderBy(asc(repositories.createdAt));
  }

  async findRepository(teamId: string, by: { id: string } | { slug: string }) {
    const [r] = await this.db.q.select().from(repositories).where(and(eq(repositories.teamId, teamId), "id" in by ? eq(repositories.id, by.id) : eq(repositories.slug, by.slug)));
    return r;
  }

  async findRepositoryByGithubId(teamId: string, githubRepoId: string) {
    const [r] = await this.db.q.select({ id: repositories.id }).from(repositories).where(and(eq(repositories.teamId, teamId), eq(repositories.githubRepoId, githubRepoId)));
    return r;
  }

  async insertRepository(values: RepositoryInsert) {
    const [r] = await this.db.q.insert(repositories).values(values).returning();
    return r;
  }

  async updateRepository(id: string, set: Partial<RepositoryInsert>) {
    const [r] = await this.db.q.update(repositories).set(set).where(eq(repositories.id, id)).returning();
    return r;
  }

  /** The checks of the repository's most recently updated pull requests, newest first (what CI has recently reported). */
  async recentPullRequestChecks(repositoryId: string, limit: number) {
    const rows = await this.db.q.select({ checks: pullRequests.checks }).from(pullRequests).where(eq(pullRequests.repositoryId, repositoryId)).orderBy(desc(pullRequests.updatedAt)).limit(limit);
    return rows.map((r) => r.checks);
  }

  async touchRepository(id: string) {
    await this.db.q.update(repositories).set({ lastEventAt: new Date() }).where(eq(repositories.id, id));
  }

  /**
   * The repositories a webhook is about: connected through GitHub, with this exact installation and repository id, and whose
   * installation is linked to the same workspace as the team.
   */
  targetsFor(installationId: string, repoId: string) {
    return this.db.q
      .select({ repo: repositories, team: teams })
      .from(repositories)
      .innerJoin(teams, eq(teams.id, repositories.teamId))
      .innerJoin(githubInstallations, and(eq(githubInstallations.installationId, repositories.githubInstallationId), eq(githubInstallations.workspaceId, teams.workspaceId)))
      .where(and(eq(repositories.provider, "github"), eq(repositories.githubInstallationId, installationId), eq(repositories.githubRepoId, repoId), ne(repositories.lifecycle, "retired")));
  }

  /**
   * Connected GitHub repositories a pull request sync reads: the same conditions as `targetsFor` (the installation is linked to the
   * team's workspace), for one team or, with no team, for every team.
   */
  syncTargets(teamId?: string, repositoryId?: string) {
    const where = [eq(repositories.provider, "github"), ne(repositories.lifecycle, "retired"), isNotNull(repositories.githubInstallationId), isNotNull(repositories.githubRepoId)];
    if (teamId) where.push(eq(repositories.teamId, teamId));
    if (repositoryId) where.push(eq(repositories.id, repositoryId));
    return this.db.q
      .select({ repo: repositories, team: teams })
      .from(repositories)
      .innerJoin(teams, eq(teams.id, repositories.teamId))
      .innerJoin(githubInstallations, and(eq(githubInstallations.installationId, repositories.githubInstallationId), eq(githubInstallations.workspaceId, teams.workspaceId)))
      .where(and(...where))
      .orderBy(asc(repositories.createdAt));
  }

  async markPrSynced(id: string, at: Date) {
    await this.db.q.update(repositories).set({ lastPrSyncedAt: at }).where(eq(repositories.id, id));
  }

  // ───────── installations ─────────

  async installationOf(workspaceId: string, installationId: string) {
    const [i] = await this.db.q.select().from(githubInstallations).where(and(eq(githubInstallations.installationId, installationId), eq(githubInstallations.workspaceId, workspaceId)));
    return i;
  }

  installationsOf(workspaceId: string) {
    return this.db.q.select().from(githubInstallations).where(eq(githubInstallations.workspaceId, workspaceId));
  }

  async upsertInstallation(i: { installationId: string; workspaceId: string; accountLogin: string; accountType: string; connectedBy: string }) {
    await this.db.q
      .insert(githubInstallations)
      .values(i)
      .onConflictDoUpdate({ target: [githubInstallations.installationId, githubInstallations.workspaceId], set: { accountLogin: i.accountLogin, accountType: i.accountType } });
  }

  /** GitHub removed the App: every workspace's link to it goes. */
  async deleteInstallation(installationId: string) {
    await this.db.q.delete(githubInstallations).where(eq(githubInstallations.installationId, installationId));
  }

  /** One workspace stops using an installation; its repositories lose the installation id, so nothing there can reach GitHub through it. */
  async unlinkInstallation(workspaceId: string, installationId: string) {
    await this.db.q.delete(githubInstallations).where(and(eq(githubInstallations.installationId, installationId), eq(githubInstallations.workspaceId, workspaceId)));
    await this.db.q.update(repositories).set({ githubInstallationId: null }).where(and(eq(repositories.workspaceId, workspaceId), eq(repositories.githubInstallationId, installationId)));
  }

  // ───────── deliveries ─────────

  /** True when this delivery id was new (and is now claimed). */
  async claimDelivery(id: string, event: string): Promise<boolean> {
    const claimed = await this.db.q.insert(githubDeliveries).values({ id, event }).onConflictDoNothing().returning({ id: githubDeliveries.id });
    return claimed.length > 0;
  }

  async releaseDelivery(id: string) {
    await this.db.q.delete(githubDeliveries).where(eq(githubDeliveries.id, id));
  }

  // ───────── pull requests ─────────

  async pullRequest(repositoryId: string, number: number) {
    const [pr] = await this.db.q.select().from(pullRequests).where(and(eq(pullRequests.repositoryId, repositoryId), eq(pullRequests.number, number)));
    return pr;
  }

  async upsertPullRequest(values: PullRequestInsert, set: Partial<PullRequestInsert>) {
    const [row] = await this.db.q.insert(pullRequests).values(values).onConflictDoUpdate({ target: [pullRequests.repositoryId, pullRequests.number], set }).returning();
    return row;
  }

  /** The pull request's links to issues become exactly these. */
  async replaceLinks(pullRequestId: string, issueIds: string[]) {
    await this.db.q.delete(pullRequestIssues).where(eq(pullRequestIssues.pullRequestId, pullRequestId));
    if (issueIds.length) await this.db.q.insert(pullRequestIssues).values(issueIds.map((issueId) => ({ pullRequestId, issueId }))).onConflictDoNothing();
  }

  linkedIssueIds(pullRequestId: string) {
    return this.db.q.select({ issueId: pullRequestIssues.issueId }).from(pullRequestIssues).where(eq(pullRequestIssues.pullRequestId, pullRequestId));
  }

  pullRequestsAtHead(repositoryId: string, headSha: string) {
    return this.db.q.select().from(pullRequests).where(and(eq(pullRequests.repositoryId, repositoryId), eq(pullRequests.headSha, headSha)));
  }

  pullRequestsByNumbers(repositoryId: string, numbers: number[]) {
    return this.db.q.select().from(pullRequests).where(and(eq(pullRequests.repositoryId, repositoryId), inArray(pullRequests.number, numbers)));
  }

  async updateChecks(id: string, checks: PullRequestRow["checks"], ciState: PullRequestRow["ciState"]) {
    await this.db.q.update(pullRequests).set({ checks, ciState, updatedAt: new Date() }).where(eq(pullRequests.id, id));
  }

  /** Pull requests linked to an issue, newest first. */
  pullRequestsForIssue(issueId: string) {
    return this.db.q
      .select({
        number: pullRequests.number,
        title: pullRequests.title,
        url: pullRequests.url,
        state: pullRequests.state,
        draft: pullRequests.draft,
        ciState: pullRequests.ciState,
        headBranch: pullRequests.headBranch,
        repository: repositories.displayName,
        updatedAt: pullRequests.updatedAt,
      })
      .from(pullRequestIssues)
      .innerJoin(pullRequests, eq(pullRequests.id, pullRequestIssues.pullRequestId))
      .innerJoin(repositories, eq(repositories.id, pullRequests.repositoryId))
      .where(eq(pullRequestIssues.issueId, issueId))
      .orderBy(desc(pullRequests.updatedAt));
  }

  // ───────── issues, statuses, events (read for a delivery) ─────────

  /** The team's issues with these numbers, with their status name. */
  issuesByNumbers(teamId: string, numbers: number[]) {
    return this.db.q
      .select({ t: issues, status: statuses.name })
      .from(issues)
      .innerJoin(statuses, eq(statuses.id, issues.statusId))
      .where(and(eq(issues.teamId, teamId), inArray(issues.number, numbers)));
  }

  async issueById(id: string) {
    const [i] = await this.db.q.select().from(issues).where(eq(issues.id, id));
    return i;
  }

  boardStatuses(teamId: string) {
    return this.db.q.select({ id: statuses.id, name: statuses.name, role: statuses.role }).from(statuses).where(eq(statuses.teamId, teamId)).orderBy(statuses.position);
  }

  /** The latest move of an issue, who made it and when. */
  async lastMove(issueId: string) {
    const [last] = await this.db.q
      .select({ at: events.createdAt, by: events.actorName, actorId: events.actorId })
      .from(events)
      .where(and(eq(events.entityId, issueId), eq(events.type, "issue.moved")))
      .orderBy(desc(events.seq))
      .limit(1);
    return last;
  }
}
