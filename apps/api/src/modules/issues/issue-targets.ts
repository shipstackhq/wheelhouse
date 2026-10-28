import { Inject, Injectable } from "@nestjs/common";
import { ServiceError } from "../../common/service-error";
import { github } from "../github/index";
import { IssuesRepository } from "./issues.repository";
import { MAX_ISSUE_DEPTH, type TargetInput } from "./issues.rules";

export type Target = { repositoryId: string; baseBranch: string };

/**
 * WH-129: where an issue's work happens. A target is a connected GitHub repository of the issue's team (or of a team in its project)
 * and a branch that exists there; both are checked when the targets are set, so a typo is refused now and not in a run. An issue
 * without targets of its own uses its nearest ancestor's.
 */
@Injectable()
export class IssueTargets {
  constructor(@Inject(IssuesRepository) private readonly repo: IssuesRepository) {}

  /** The repositories a run of the issue can work in: connected GitHub repositories, not retired, of its team or of a team in its project. */
  async candidates(issue: { teamId: string; projectId: string | null }) {
    return (await this.repo.candidateRepositories(issue.teamId, issue.projectId)).filter((r) => r.provider === "github" && r.githubFullName && r.lifecycle !== "retired");
  }

  /** The checked targets for what was named, among the issue's candidate repositories. Throws on a repository that is not a candidate, one named twice, or a branch GitHub does not have (or cannot be asked about). */
  async resolve(issue: { teamId: string; projectId: string | null }, input: TargetInput[]): Promise<Target[]> {
    return this.resolveIn(await this.candidates(issue), input);
  }

  async resolveIn(candidates: Awaited<ReturnType<IssueTargets["candidates"]>>, input: TargetInput[]): Promise<Target[]> {
    const out: Target[] = [];
    for (const [i, t] of input.entries()) {
      const repo = candidates.find((r) => r.id === t.repository || r.githubFullName?.toLowerCase() === t.repository.toLowerCase());
      if (!repo) throw new ServiceError("invalid", `${t.repository} is not a connected GitHub repository of this issue's team or project`, { fields: { targets: `targets[${i}]: unknown repository` } });
      if (out.some((o) => o.repositoryId === repo.id)) throw new ServiceError("invalid", `${repo.githubFullName} is listed twice`, { fields: { targets: `targets[${i}]: repeated repository` } });
      const baseBranch = t.branch?.trim() || repo.defaultBranch;
      if (baseBranch !== repo.defaultBranch) {
        const gh = github();
        const names = gh && repo.githubInstallationId && repo.githubRepoId ? await gh.api.branches(repo.githubInstallationId, repo.githubRepoId).catch(() => null) : null;
        if (!names) throw new ServiceError("invalid", `Could not check ${baseBranch} on GitHub; try again`, { fields: { targets: `targets[${i}]: branch not checked` } });
        if (!names.includes(baseBranch)) throw new ServiceError("invalid", `${repo.githubFullName} has no branch ${baseBranch}`, { fields: { targets: `targets[${i}]: no such branch` } });
      }
      out.push({ repositoryId: repo.id, baseBranch });
    }
    return out;
  }

  /** The targets set on the issue, in order, for comparing with a new list. */
  own(issueId: string) {
    return this.repo.ownTargets(issueId);
  }

  /**
   * The issue's targets: its own, else its nearest ancestor's, else its project's repository when the project has exactly one (several
   * are only proposals). `inherited` when they are not its own.
   */
  async of(issueId: string) {
    let rows = await this.repo.settledTargets(issueId, MAX_ISSUE_DEPTH);
    if (!rows.length) {
      const projectId = await this.repo.projectIdOf(issueId);
      const only = projectId ? await this.repo.projectRepositoryRows(projectId) : [];
      if (only.length === 1) rows = [{ from: "", repositoryId: only[0].repositoryId, baseBranch: only[0].branch ?? only[0].defaultBranch, name: only[0].name, fullName: only[0].fullName }];
    }
    return { targets: rows.map((r) => ({ repositoryId: r.repositoryId, repository: r.fullName ?? r.name, baseBranch: r.baseBranch })), inherited: rows.length > 0 && rows[0].from !== issueId };
  }

  /**
   * Where the work probably happens, for an issue with no settled targets: the project's repositories, those of the linked map nodes'
   * files, of earlier runs and pull requests, and any the title or body names. Proposals only: a person confirms them.
   */
  async proposals(issue: { id: string; teamId: string; projectId: string | null; title: string; body: string }) {
    const candidates = await this.candidates(issue);
    const byId = new Map(candidates.map((r) => [r.id, r]));
    const project = issue.projectId ? await this.repo.projectRepositoryRows(issue.projectId) : [];
    const branchOf = new Map(project.map((p) => [p.repositoryId, p.branch]));
    const text = `${issue.title}\n${issue.body}`.toLowerCase();
    const named = candidates.filter((r) => text.includes(r.githubFullName!.toLowerCase()) || (r.displayName.length > 2 && text.includes(r.displayName.toLowerCase()))).map((r) => r.id);
    const ids = [...project.map((p) => p.repositoryId), ...(await this.repo.anchorRepositories(issue.id)), ...(await this.repo.workedRepositories(issue.id)), ...named];
    return [...new Set(ids)].flatMap((id) => {
      const r = byId.get(id);
      return r ? [{ repositoryId: id, repository: r.githubFullName!, baseBranch: branchOf.get(id) ?? r.defaultBranch }] : [];
    });
  }

  set(issueId: string, targets: Target[]) {
    return this.repo.replaceTargets(issueId, targets);
  }

  /** A project's repositories (WH-135), each with the branch its issues start from. */
  async ofProject(projectId: string) {
    return (await this.repo.projectRepositoryRows(projectId)).map((r) => ({ repositoryId: r.repositoryId, repository: r.fullName ?? r.name, branch: r.branch ?? r.defaultBranch }));
  }

  /** Replace a project's repositories; each must be a connected GitHub repository of a team in the project, on a branch that exists. */
  async setProject(project: { id: string; leadTeamId: string }, input: TargetInput[]) {
    const resolved = await this.resolveIn(await this.candidates({ teamId: project.leadTeamId, projectId: project.id }), input);
    await this.repo.replaceProjectRepositories(project.id, resolved.map((t) => ({ repositoryId: t.repositoryId, branch: t.baseBranch })));
  }
}
