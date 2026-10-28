import { Inject, Injectable } from "@nestjs/common";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { Database } from "../../platform/database/database";
import { TeamAccessService } from "../teams/index";
import type { GithubApi, SyncedPullRequest } from "./api";
import { DeliveriesService } from "./deliveries.service";
import { GithubRepository } from "./github.repository";
import { github } from "./runtime";

/** Pull requests closed within this window are read along with the open ones. */
export const SYNC_CLOSED_DAYS = 30;

export type SyncResult = { repositoryId: string; ok: boolean; pullRequests: number; error?: string };

type Target = Awaited<ReturnType<GithubRepository["syncTargets"]>>[number];

/**
 * WH-142: reads each connected repository's pull requests through the GitHub API and writes them through the webhook's own path
 * (`DeliveriesService.applyPullRequest`), so a PR found merged moves its issue exactly as a webhook would. Idempotent: events and
 * moves are raised only for a PR that is new to us or whose state changed; a repeat finds nothing to say. A repository's
 * `lastPrSyncedAt` is set when its sync finishes successfully, never when it starts or fails.
 */
@Injectable()
export class PrSyncService {
  constructor(
    @Inject(GithubRepository) private readonly repo: GithubRepository,
    @Inject(DeliveriesService) private readonly deliveries: DeliveriesService,
    @Inject(TeamAccessService) private readonly teams: TeamAccessService,
    @Inject(Database) private readonly db: Database,
  ) {}

  /** The button: every connected repository of a team ("check again now"). */
  async syncTeam(actor: Actor, teamRef: string, api: GithubApi | null = github()?.api ?? null, now = new Date()): Promise<SyncResult[]> {
    if (actor.kind !== "human") throw new ServiceError("forbidden", "Only teammates can sync pull requests");
    const team = await this.teams.require(actor, teamRef, "edit");
    if (!api) throw new ServiceError("invalid", "GitHub is not set up on this server");
    return this.run(await this.repo.syncTargets(team.id), api, now);
  }

  /** On server start: every connected repository of every team. Never throws; a failure is logged. */
  async syncAll(api: GithubApi | null = github()?.api ?? null, now = new Date()): Promise<SyncResult[]> {
    if (!api) return [];
    try {
      return await this.run(await this.repo.syncTargets(), api, now);
    } catch (e) {
      console.error("[github] pull request sync failed:", e instanceof Error ? e.message : e);
      return [];
    }
  }

  /** When a repository is connected. Never throws. */
  async syncRepository(repositoryId: string, api: GithubApi | null = github()?.api ?? null, now = new Date()): Promise<SyncResult[]> {
    if (!api) return [];
    try {
      return await this.run(await this.repo.syncTargets(undefined, repositoryId), api, now);
    } catch (e) {
      console.error("[github] pull request sync failed:", e instanceof Error ? e.message : e);
      return [];
    }
  }

  private async run(targets: Target[], api: GithubApi, now: Date): Promise<SyncResult[]> {
    const out: SyncResult[] = [];
    for (const t of targets) {
      try {
        out.push({ repositoryId: t.repo.id, ok: true, pullRequests: await this.syncOne(t, api, now) });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        console.error(`[github] pull request sync of ${t.repo.githubFullName ?? t.repo.id} failed:`, error);
        out.push({ repositoryId: t.repo.id, ok: false, pullRequests: 0, error });
      }
    }
    return out;
  }

  private async syncOne(t: Target, api: GithubApi, now: Date): Promise<number> {
    const since = new Date(now.getTime() - SYNC_CLOSED_DAYS * 86_400_000);
    const prs = await api.pullRequests(t.repo.githubInstallationId!, t.repo.githubRepoId!, since);
    for (const pr of prs) {
      await this.db.transaction(async () => {
        const existing = await this.repo.pullRequest(t.repo.id, pr.number);
        await this.deliveries.applyPullRequest(t, pr, actionFor(existing?.state ?? null, pr), false);
      });
    }
    await this.repo.markPrSynced(t.repo.id, new Date()); // only after everything was read and written
    return prs.length;
  }
}

/** What a webhook would have said: opened/closed/reopened when the state is new to us, otherwise nothing that raises an event. */
export function actionFor(before: "open" | "closed" | "merged" | null, pr: Pick<SyncedPullRequest, "state" | "merged">): string {
  const now = pr.merged ? "merged" : pr.state === "closed" ? "closed" : "open";
  if (before === now) return "synchronize";
  if (now === "open") return before === null ? "opened" : "reopened";
  return "closed";
}
