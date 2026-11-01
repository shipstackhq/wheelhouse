import { Inject, Injectable } from "@nestjs/common";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import type { CiDetected, CiPolicy } from "../../db/tables/github";
import { TeamAccessService } from "../teams/index";
import type { GithubApi } from "./api";
import { GithubRepository, type RepositoryRow } from "./github.repository";
import { github } from "./runtime";

/** How many recent default-branch commits and pull request heads detection looks at. */
const RECENT = 10;

/** The default a person is offered, from what detection found: GitHub's own required checks if it has any, else every check. */
export const suggestedPolicy = (d: CiDetected): CiPolicy => ({ mode: d.mode, required: d.requiredFromProtection.length ? "branch_protection" : "all", optionalIfAbsent: [], startTimeoutMinutes: 10 });

/** The check names a policy requires, given what GitHub requires of the branch. `all` has no names to list. */
const requiredNames = (policy: CiPolicy, fromProtection: string[]) => (policy.required === "branch_protection" ? fromProtection : Array.isArray(policy.required) ? policy.required : []);

/**
 * WH-189 (ADR-26): reads a repository's CI from GitHub and records what it found for a person to accept ("suggest, then apply").
 * Detection only ever writes `ciDetected`; the confirmed `ciPolicy` changes through the repository edit. It also warns when a required
 * check has not shown on any recent pull request (a renamed or removed job), which never blocks anything.
 */
@Injectable()
export class CiPolicyService {
  constructor(
    @Inject(GithubRepository) private readonly repo: GithubRepository,
    @Inject(TeamAccessService) private readonly teams: TeamAccessService,
  ) {}

  /** The "Detect" action for one repository of a team. */
  async detectRepository(actor: Actor, teamRef: string, id: string, api: GithubApi | null = github()?.api ?? null): Promise<RepositoryRow> {
    if (actor.kind !== "human") throw new ServiceError("forbidden", "Only teammates can detect a repository's CI");
    const team = await this.teams.require(actor, teamRef, "edit");
    if (!api) throw new ServiceError("invalid", "GitHub is not set up on this server");
    const [target] = await this.repo.syncTargets(team.id, id);
    if (!target) throw new ServiceError("not_found", `Repository "${id}" is not connected to GitHub`);
    return this.detect(target.repo, api);
  }

  /** On connect, on server start and daily: every connected repository, or one. Never throws; a failure is logged. */
  async detectAll(repositoryId?: string, api: GithubApi | null = github()?.api ?? null): Promise<void> {
    if (!api) return;
    try {
      for (const t of await this.repo.syncTargets(undefined, repositoryId)) {
        await this.detect(t.repo, api).catch((e) => console.error(`[github] CI detection of ${t.repo.githubFullName ?? t.repo.id} failed:`, e instanceof Error ? e.message : e));
      }
    } catch (e) {
      console.error("[github] CI detection failed:", e instanceof Error ? e.message : e);
    }
  }

  private async detect(r: RepositoryRow, api: GithubApi): Promise<RepositoryRow> {
    const inst = r.githubInstallationId!;
    const id = r.githubRepoId!;
    const protection = await api.requiredChecks(inst, id, r.defaultBranch);
    const mode = (await api.branchHasChecks(inst, id, r.defaultBranch, RECENT)) ? "github_checks" : "none";
    const warnings: string[] = [];
    if (!protection.readable) warnings.push("GitHub would not say which checks the default branch requires (the app needs Administration: read)");
    const detected: CiDetected = { at: new Date().toISOString(), mode, requiredFromProtection: protection.names, warnings };
    const recent = await this.repo.recentPullRequestChecks(r.id, RECENT);
    const seen = new Set(recent.flatMap((checks) => Object.keys(checks)));
    const policy = r.ciPolicy ?? suggestedPolicy(detected);
    if (recent.length) for (const name of requiredNames(policy, protection.names)) if (!seen.has(name) && !policy.optionalIfAbsent.includes(name)) detected.warnings.push(`required check "${name}" has not been seen on a recent pull request`);
    return this.repo.updateRepository(r.id, { ciDetected: detected });
  }
}
