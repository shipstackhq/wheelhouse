import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { requireHuman } from "@/lib/auth";
import { getProject, listRepositories, ServiceError } from "@wheelhouse/core/lib/service";
import { onboarding } from "@wheelhouse/core/lib/onboarding";
import { GithubConnect } from "../repos/github-connect";
import { Repos } from "../repos/repos";
import { OnboardingWizard } from "./wizard";

/**
 * WH-69: the guided onboarding flow after "New project". Steps 1 (name/description) are already covered by the
 * new-project form, so this wizard starts at step 2 (code location) per the ticket's own suggestion not to make
 * people retype what they just typed. Each step is skippable and the wizard never traps anyone — "Skip to board"
 * is always available (see OnboardingWizard).
 */
export default async function OnboardingPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ github?: string; github_error?: string; github_msg?: string }>;
}) {
  const { key } = await params;
  const sp = await searchParams;
  const { actor, membership } = await requireHuman();
  let project;
  try {
    project = await getProject(actor, key);
  } catch (e) {
    if (e instanceof ServiceError) notFound();
    throw e;
  }
  const repos = await listRepositories(actor, key);
  const h = await headers();
  const origin = process.env.APP_URL ?? `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
  const cmd = onboarding({ origin, projectKey: key });

  return (
    <OnboardingWizard
      projectKey={key}
      projectName={project.name}
      hasRepos={repos.length > 0}
      cmd={cmd}
      githubConnect={<GithubConnect projectKey={key} actor={actor} isOwner={membership.role === "owner"} connectedRepoIds={repos.map((r) => r.githubRepoId).filter((x): x is string => !!x)} params={sp} />}
      localRepos={<Repos projectKey={key} repos={repos.map((r) => ({ id: r.id, displayName: r.displayName, role: r.role, provider: r.provider, slug: r.slug, defaultBranch: r.defaultBranch, pathLimit: r.pathLimit, lifecycle: r.lifecycle, lastEventAt: r.lastEventAt ? r.lastEventAt.toISOString() : null }))} />}
    />
  );
}
