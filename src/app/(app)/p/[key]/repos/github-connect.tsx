import { connectGithubRepositoryAction } from "@/app/actions";
import { SubmitButton } from "@/components/submit-button";
import { githubConfig, githubMissing } from "@/lib/github/config";
import { github } from "@/lib/github/runtime";
import { listInstallations } from "@/lib/github/service";
import type { Actor } from "@/lib/access";

const MESSAGES: Record<string, string> = {
  not_configured: "GitHub is not set up on this server yet.",
  owner_only: "Only team owners can connect GitHub.",
  bad_installation: "GitHub sent back something we could not read. Try again.",
  no_code: "GitHub did not confirm who you are. In the GitHub App's settings, switch on “Request user authorization (OAuth) during installation”, then try again.",
  not_yours: "GitHub says you cannot administer that installation, so it was not connected.",
  taken: "That GitHub installation is already connected to another team.",
  failed: "Something went wrong talking to GitHub. Try again in a minute.",
  connect_failed: "That repository could not be connected.",
};

/**
 * "Connect GitHub" for a project: installing the App (owners), then choosing which of the installation's repositories this
 * project uses. The list comes from GitHub; everything that matters is checked again on the server when you press Connect.
 */
export async function GithubConnect({ projectKey, actor, isOwner, connectedRepoIds, params }: { projectKey: string; actor: Actor; isOwner: boolean; connectedRepoIds: string[]; params: { github?: string; github_error?: string; github_msg?: string } }) {
  const cfg = githubConfig();
  const note = params.github_error ? (params.github_error === "connect_failed" && params.github_msg ? params.github_msg : (MESSAGES[params.github_error] ?? MESSAGES.failed)) : params.github === "repo_connected" ? "Repository connected." : params.github === "connected" ? "GitHub connected. Choose the repositories this project uses." : null;
  const bad = !!params.github_error;

  if (!cfg) {
    return (
      <section className="card mt-6 p-5">
        <h2 className="font-medium">GitHub</h2>
        <p className="mt-1 text-sm text-muted">
          GitHub is not set up on this server, so pushes and pull requests are not reported automatically; repositories linked from a machine with the plugin still work.
          {isOwner && <> To enable it, an administrator creates a GitHub App and sets {githubMissing().map((n) => <code key={n} className="mx-0.5 font-mono text-xs">{n}</code>)} (see the deploy guide).</>}
        </p>
      </section>
    );
  }

  const installs = isOwner ? await listInstallations(actor) : [];
  const gh = github();
  const found: { installationId: string; account: string; repos: { id: string; fullName: string; private: boolean }[]; failed: boolean }[] = [];
  for (const i of installs) {
    try {
      const repos = (await gh!.api.installationRepositories(i.installationId)).filter((r) => !connectedRepoIds.includes(r.id));
      found.push({ installationId: i.installationId, account: i.accountLogin, repos, failed: false });
    } catch {
      found.push({ installationId: i.installationId, account: i.accountLogin, repos: [], failed: true });
    }
  }

  return (
    <section className="card mt-6 space-y-4 p-5">
      <div>
        <h2 className="font-medium">GitHub</h2>
        <p className="mt-1 text-sm text-muted">
          Connecting a repository through GitHub means every push to its default branch is reported, whoever made it and whether or not they run the plugin, and its pull requests and CI results show on the tickets they mention.
        </p>
      </div>
      {note && <p role="status" className={bad ? "text-sm text-danger" : "text-sm text-ok"}>{note}</p>}
      {!isOwner ? (
        <p className="text-sm text-muted">A team owner connects GitHub for this project.</p>
      ) : (
        <>
          <a className="btn btn-primary inline-flex" href={`/api/github/install?project=${encodeURIComponent(projectKey)}`}>
            {installs.length ? "Add or change repositories on GitHub" : "Connect GitHub"}
          </a>
          {found.map((f) => (
            <div key={f.installationId}>
              <div className="text-xs font-medium text-muted">{f.account || "GitHub"}</div>
              {f.failed ? (
                <p className="mt-1 text-sm text-danger">Could not load this installation&apos;s repositories from GitHub.</p>
              ) : f.repos.length === 0 ? (
                <p className="mt-1 text-sm text-muted">Every repository this installation can see is already connected here. Use the button above to give it access to more.</p>
              ) : (
                <ul className="mt-1 divide-y divide-line text-sm">
                  {f.repos.map((r) => (
                    <li key={r.id} className="py-2">
                      <form action={connectGithubRepositoryAction} className="flex flex-wrap items-center gap-2">
                        <input type="hidden" name="project" value={projectKey} />
                        <input type="hidden" name="installationId" value={f.installationId} />
                        <input type="hidden" name="repoId" value={r.id} />
                        <span className="min-w-40 flex-1 truncate font-mono text-xs">
                          {r.fullName}
                          {r.private && <span className="ml-2 text-muted">private</span>}
                        </span>
                        <input className="input w-28 py-1" name="role" placeholder="role, e.g. backend" aria-label={`Role of ${r.fullName}`} />
                        <input className="input w-40 py-1" name="pathLimit" placeholder="path limit (monorepo)" aria-label={`Path limit for ${r.fullName}`} />
                        <SubmitButton className="btn py-1 text-xs">Connect</SubmitButton>
                      </form>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </>
      )}
    </section>
  );
}
