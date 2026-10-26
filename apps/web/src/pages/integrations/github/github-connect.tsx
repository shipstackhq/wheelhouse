import { useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { GithubStatus } from "@wheelhouse/api-client";
import { SubmitButton } from "../../../components/submit-button";
import { describeFailure } from "../../../lib/form-state";
import { githubQuery } from "../../../lib/queries";
import { refreshAll } from "../../../lib/refresh";
import { useServices } from "../../../lib/services";
import { useWorkspaceSlug } from "../../../lib/workspace";
import { useState } from "react";

const MESSAGES: Record<string, string> = {
  not_configured: "GitHub is not set up on this server yet.",
  owner_only: "Only workspace owners can connect GitHub.",
  bad_installation: "GitHub sent back something we could not read. Try again.",
  no_code: "GitHub did not confirm who you are. In the GitHub App's settings, switch on “Request user authorization (OAuth) during installation”, then try again.",
  not_yours: "GitHub says you cannot administer that installation, so it was not connected.",
  taken: "That GitHub installation is already connected to another workspace.",
  failed: "Something went wrong talking to GitHub. Try again in a minute.",
  connect_failed: "That repository could not be connected.",
};

/** What the page says about where the person has just been (the install flow sends them back with `github=` or `github_error=`). */
export function githubNote(params: URLSearchParams): { text: string; bad: boolean } | null {
  const error = params.get("github_error");
  if (error) return { bad: true, text: error === "connect_failed" && params.get("github_msg") ? params.get("github_msg")! : (MESSAGES[error] ?? MESSAGES.failed) };
  const ok = params.get("github");
  if (ok === "repo_connected") return { bad: false, text: "Repository connected." };
  if (ok === "connected") return { bad: false, text: "GitHub connected. Choose the repositories this team uses." };
  return null;
}

/**
 * "Connect GitHub" for a team: installing the App (owners), then choosing which of the installation's repositories this team
 * uses. The list comes from GitHub through the server; everything that matters is checked again there when you press Connect.
 */
export function GithubConnect({ teamKey }: { teamKey: string }) {
  const { api } = useServices();
  const slug = useWorkspaceSlug();
  const query = useQuery(githubQuery(api, teamKey));
  const [params] = useSearchParams();
  const note = githubNote(params);
  const status = query.data;

  if (query.isError) {
    return (
      <section className="card mt-6 p-5">
        <h2 className="font-medium">GitHub</h2>
        <p role="alert" className="mt-1 text-sm text-danger">Could not load the GitHub connection. Try again in a moment.</p>
      </section>
    );
  }
  if (!status) {
    return (
      <section className="card mt-6 p-5" aria-busy>
        <h2 className="font-medium">GitHub</h2>
        <p className="mt-1 text-sm text-muted">Loading…</p>
      </section>
    );
  }
  if (!status.configured) {
    return (
      <section className="card mt-6 p-5">
        <h2 className="font-medium">GitHub</h2>
        <p className="mt-1 text-sm text-muted">
          GitHub is not set up on this server, so pushes and pull requests are not reported automatically; repositories linked from a machine with the plugin still work.
          {status.isOwner && (
            <>
              {" "}
              To enable it, an administrator creates a GitHub App and sets{" "}
              {status.missing.map((n) => (
                <code key={n} className="mx-0.5 font-mono text-xs">{n}</code>
              ))}{" "}
              (see the deploy guide).
            </>
          )}
        </p>
      </section>
    );
  }
  return (
    <section className="card mt-6 space-y-4 p-5">
      <div>
        <h2 className="font-medium">GitHub</h2>
        <p className="mt-1 text-sm text-muted">
          Connecting a repository through GitHub means every push to its default branch is reported, whoever made it and whether or not they run the plugin, and its pull requests and CI results show on the issues they mention.
        </p>
      </div>
      {note && <p role="status" className={note.bad ? "text-sm text-danger" : "text-sm text-ok"}>{note.text}</p>}
      {!status.isOwner ? (
        <p className="text-sm text-muted">A workspace owner connects GitHub for this team.</p>
      ) : (
        <>
          {/* A full page load: this leaves the app for GitHub and comes back to the callback, which redirects here. */}
          <a className="btn btn-primary inline-flex" href={`/api/github/install?workspace=${encodeURIComponent(slug ?? "")}&team=${encodeURIComponent(teamKey)}`}>
            {status.installations.length ? "Add or change repositories on GitHub" : "Connect GitHub"}
          </a>
          {status.installations.map((i) => (
            <Installation key={i.installationId} teamKey={teamKey} installation={i} />
          ))}
        </>
      )}
    </section>
  );
}

function Installation({ teamKey, installation: f }: { teamKey: string; installation: GithubStatus["installations"][number] }) {
  const { api, queryClient } = useServices();
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const connect = async (repoId: string, fd: FormData) => {
    try {
      await api.repos.connectGithub(teamKey, {
        installationId: f.installationId,
        repoId,
        role: String(fd.get("role") ?? "").trim() || undefined,
        pathLimit: String(fd.get("pathLimit") ?? "").trim() || null,
      });
      setMessage({ bad: false, text: "Repository connected." });
    } catch (e) {
      setMessage({ bad: true, text: describeFailure(e) });
    }
    await refreshAll(queryClient);
  };
  return (
    <div>
      <div className="text-xs font-medium text-muted">{f.account || "GitHub"}</div>
      {message && <p role="status" className={message.bad ? "mt-1 text-sm text-danger" : "mt-1 text-sm text-ok"}>{message.text}</p>}
      {f.failed ? (
        <p className="mt-1 text-sm text-danger">Could not load this installation&apos;s repositories from GitHub.</p>
      ) : f.repositories.length === 0 ? (
        <p className="mt-1 text-sm text-muted">Every repository this installation can see is already connected here. Use the button above to give it access to more.</p>
      ) : (
        <ul className="mt-1 divide-y divide-line text-sm">
          {f.repositories.map((r) => (
            <li key={r.id} className="py-2">
              <form action={(fd) => connect(r.id, fd)} className="flex flex-wrap items-center gap-2">
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
  );
}
