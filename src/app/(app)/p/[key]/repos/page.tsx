import { requireHuman } from "@/lib/auth";
import { listRepositories } from "@/lib/service";
import { Repos } from "./repos";
import { GithubConnect } from "./github-connect";

export default async function ReposPage({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: Promise<{ github?: string; github_error?: string; github_msg?: string }> }) {
  const { key } = await params;
  const sp = await searchParams;
  const { actor, membership } = await requireHuman();
  const repos = await listRepositories(actor, key);
  return (
    <Repos
      projectKey={key}
      repos={repos.map((r) => ({
          id: r.id,
          displayName: r.displayName,
          role: r.role,
          provider: r.provider,
          slug: r.slug,
          defaultBranch: r.defaultBranch,
          pathLimit: r.pathLimit,
          lifecycle: r.lifecycle,
          lastEventAt: r.lastEventAt ? r.lastEventAt.toISOString() : null,
        }))}
        after={<GithubConnect projectKey={key} actor={actor} isOwner={membership.role === "owner"} connectedRepoIds={repos.map((r) => r.githubRepoId).filter((x): x is string => !!x)} params={sp} />}
      />
  );
}
