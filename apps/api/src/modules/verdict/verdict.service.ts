import { Inject, Injectable } from "@nestjs/common";
import { suggestedPolicy } from "../github/index";
import { DEFAULT_POLICY, verdictFor, worst, type Verdict } from "./verdict.rules";
import { VerdictRepository } from "./verdict.repository";

/** A pull request's head: what a verdict needs of it. `updatedAt` stands for the time of the push (a new commit clears the checks, so until one reports it is the push). */
export type PullRequestHead = { repositoryId: string; headSha: string; checks: Record<string, { status: string; conclusion: string | null }>; updatedAt: Date };

/**
 * WH-190 (ADR-26): the verdict of a commit, and of an issue (the worst across its open pull requests), the one thing every consumer
 * reads instead of CI signals. A repository's policy is the confirmed one, else what detection suggests, else GitHub checks required of all.
 */
@Injectable()
export class VerdictService {
  constructor(@Inject(VerdictRepository) private readonly repo: VerdictRepository) {}

  /** One verdict per pull request head, in order. */
  async ofHeads(heads: PullRequestHead[]): Promise<Verdict[]> {
    const policies = new Map((await this.repo.policies([...new Set(heads.map((h) => h.repositoryId))])).map((p) => [p.id, p]));
    const now = new Date();
    return Promise.all(
      heads.map(async (h) => {
        const p = policies.get(h.repositoryId);
        return verdictFor({
          policy: p?.ciPolicy ?? (p?.ciDetected ? suggestedPolicy(p.ciDetected) : DEFAULT_POLICY),
          protectionRequired: p?.ciDetected?.requiredFromProtection ?? [],
          selfChecks: h.headSha ? await this.repo.selfChecksFor(h.repositoryId, h.headSha) : null,
          checks: h.checks,
          pushedAt: h.updatedAt,
          now,
        });
      }),
    );
  }

  /** Like `ofHeads` for rows that may have no pull request (a left join): null where there is none. */
  async ofJoined(heads: (PullRequestHead | null)[]): Promise<(Verdict | null)[]> {
    const found = await this.ofHeads(heads.filter((h): h is PullRequestHead => !!h));
    let next = 0;
    return heads.map((h) => (h ? found[next++] : null));
  }

  /** The issue's verdict: the worst of its open pull requests' heads, or null when it has none. */
  async issueVerdict(issueId: string): Promise<Verdict | null> {
    const heads = await this.repo.openPullRequestsOf(issueId);
    return heads.length ? worst(await this.ofHeads(heads)) : null;
  }
}
