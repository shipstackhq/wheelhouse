import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { schema } from "../../db";
import { Database } from "../../platform/database/database";
import type { SelfCheck } from "./verdict.rules";

const { repositories, deviceJobs, pullRequests, pullRequestIssues } = schema;

/** The queries behind a verdict, read only: a repository's policy, the self-checks of a commit (the daemon module owns the table) and an issue's open pull requests. */
@Injectable()
export class VerdictRepository {
  constructor(@Inject(Database) private readonly db: Database) {}

  policies(repositoryIds: string[]) {
    if (!repositoryIds.length) return [];
    return this.db.q.select({ id: repositories.id, ciPolicy: repositories.ciPolicy, ciDetected: repositories.ciDetected }).from(repositories).where(inArray(repositories.id, repositoryIds));
  }

  /** WH-191: the results of the newest run that checked this commit, or null when none did. */
  async selfChecksFor(repositoryId: string, sha: string): Promise<SelfCheck[] | null> {
    const [row] = await this.db.q
      .select({ checks: sql<SelfCheck[] | null>`${deviceJobs.result}->'checks'` })
      .from(deviceJobs)
      .where(and(eq(deviceJobs.repositoryId, repositoryId), sql`${deviceJobs.result}->>'checkedSha' = ${sha}`))
      .orderBy(desc(deviceJobs.createdAt))
      .limit(1);
    return row ? (row.checks ?? []) : null;
  }

  openPullRequestsOf(issueId: string) {
    return this.db.q
      .select({ repositoryId: pullRequests.repositoryId, headSha: pullRequests.headSha, checks: pullRequests.checks, updatedAt: pullRequests.updatedAt })
      .from(pullRequestIssues)
      .innerJoin(pullRequests, eq(pullRequests.id, pullRequestIssues.pullRequestId))
      .where(and(eq(pullRequestIssues.issueId, issueId), eq(pullRequests.state, "open")));
  }
}
