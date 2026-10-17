import { useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Loaded } from "../../components/query-state";
import { onboardingQuery, useRepos } from "../../lib/queries";
import { useServices } from "../../lib/services";
import { GithubConnect } from "../repos/github-connect";
import { Repos } from "../repos/repos";
import { OnboardingWizard } from "./wizard";

/**
 * `/p/:key/onboarding`: the guided steps after "New project". The wizard never traps anyone: "Skip to board" is always there.
 * The code-location step hosts the same GitHub card and repository list as the Repos page.
 */
export function OnboardingPage() {
  const { key = "" } = useParams();
  const { api } = useServices();
  const query = useQuery(onboardingQuery(api, key));
  const repos = useRepos(key);
  return (
    <Loaded query={query} label="Loading the setup">
      {(page) => (
        <OnboardingWizard
          projectKey={page.project.key}
          projectName={page.project.name}
          hasRepos={page.hasRepos}
          cmd={page.setup}
          githubConnect={<GithubConnect projectKey={key} />}
          localRepos={repos.data ? <Repos projectKey={key} repos={repos.data} /> : null}
        />
      )}
    </Loaded>
  );
}
