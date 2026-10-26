import { useSearchParams } from "react-router";
import { Link } from "../../../lib/workspace";
import { Loaded } from "../../../components/query-state";
import { Select } from "../../../components/ui";
import { useRepos } from "../../../lib/queries";
import { useTeams } from "../../../lib/session";
import { GithubConnect } from "./github-connect";
import { Repos } from "./repos";

/**
 * `/settings/integrations/github?team=KEY`: the GitHub connection and the repositories behind a team. Repositories belong to a team,
 * so the page works on one at a time: the `team` in the address, else the first team you are on.
 */
export function GithubIntegrationPage() {
  const teams = useTeams().data;
  const [params, setParams] = useSearchParams();
  const wanted = params.get("team");
  const team = teams?.find((t) => t.key === wanted) ?? teams?.[0];
  return (
    <div className="w-full space-y-2 px-6 pt-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs text-muted">
            <Link to="/settings/integrations" className="hover:text-fg">
              Integrations
            </Link>
          </p>
          <h1 className="text-xl font-semibold">GitHub</h1>
          <p className="mt-1 text-sm text-muted">The repositories behind a team, and connecting them through the GitHub App.</p>
        </div>
        {teams && teams.length > 1 && team && (
          <Select
            ariaLabel="Team"
            value={team.key}
            options={teams.map((t) => ({ value: t.key, label: t.name }))}
            onValueChange={(key) => setParams({ team: key })}
          />
        )}
      </div>
      {!teams ? null : !team ? (
        <p className="py-6 text-sm text-muted">You are not on a team yet, so there are no repositories to connect.</p>
      ) : (
        <TeamRepos key={team.key} teamKey={team.key} />
      )}
    </div>
  );
}

function TeamRepos({ teamKey }: { teamKey: string }) {
  const query = useRepos(teamKey);
  return (
    <Loaded query={query} label="Loading repositories">
      {(repos) => <Repos teamKey={teamKey} repos={repos} after={<GithubConnect teamKey={teamKey} />} />}
    </Loaded>
  );
}
