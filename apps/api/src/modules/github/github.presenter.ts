import type { schema } from "../../db";
import type { RepositoryCheck } from "../../db/tables/github";
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
  lastEventAt: r.lastEventAt,
  lastPrSyncedAt: r.lastPrSyncedAt,
  browsable: r.provider === "github" && !!r.githubInstallationId && !!r.githubRepoId,
});
