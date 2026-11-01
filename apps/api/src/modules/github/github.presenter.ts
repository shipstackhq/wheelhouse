import type { schema } from "../../db";
import type { CiPolicy, RepositoryCheck } from "../../db/tables/github";
import { suggestedPolicy } from "./ci-policy.service";
import type { RepositoryRow } from "./github.repository";

export type RepositoryView = {
  id: string;
  displayName: string;
  role: string;
  provider: "github" | "local";
  slug: string;
  githubFullName: string | null;
  defaultBranch: string;
  pathLimit: string | null;
  lifecycle: (typeof schema.REPO_LIFECYCLES)[number];
  checks: RepositoryCheck[];
  /** WH-189: the CI policy a person confirmed; null until one does. */
  ciPolicy: CiPolicy | null;
  /** What detection suggests, shown until a policy is confirmed (or when it would differ); null before the first detection. */
  ciPolicySuggestion: CiPolicy | null;
  /** The checks GitHub requires of the default branch, which `required: "branch_protection"` follows. */
  requiredFromProtection: string[];
  /** Things worth a look, such as a required check no recent pull request has shown. They never block. */
  ciWarnings: string[];
  /** Last webhook (push or pull request) for this repository. */
  lastEventAt: Date | null;
  /** When the last successful pull request sync of this repository finished. */
  lastPrSyncedAt: Date | null;
  /** True when its file tree can be browsed (a GitHub repository with its installation), for the doc anchor picker. */
  browsable: boolean;
};

/** A repository row as the API shows it: no installation id, no workspace. */
export const repositoryView = (r: RepositoryRow): RepositoryView => ({
  id: r.id,
  displayName: r.displayName,
  role: r.role,
  provider: r.provider,
  slug: r.slug,
  githubFullName: r.githubFullName,
  defaultBranch: r.defaultBranch,
  pathLimit: r.pathLimit,
  lifecycle: r.lifecycle,
  checks: r.checks,
  ciPolicy: r.ciPolicy,
  ciPolicySuggestion: r.ciDetected ? suggestedPolicy(r.ciDetected) : null,
  requiredFromProtection: r.ciDetected?.requiredFromProtection ?? [],
  ciWarnings: r.ciDetected?.warnings ?? [],
  lastEventAt: r.lastEventAt,
  lastPrSyncedAt: r.lastPrSyncedAt,
  browsable: r.provider === "github" && !!r.githubInstallationId && !!r.githubRepoId,
});
