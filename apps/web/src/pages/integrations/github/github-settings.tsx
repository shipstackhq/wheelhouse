import { useSearchParams } from "react-router";
import { Loaded } from "../../../components/query-state";
import { Select } from "../../../components/ui";
import { useRepos } from "../../../lib/queries";
import { useTeams } from "../../../lib/session";
import { GithubConnect } from "./github-connect";
import { Repos } from "./repos";

/**
 * GitHub's settings: the repositories behind a team and connecting them through the GitHub App. Repositories belong to a team, so
 * this works on one at a time: the `team` in the address, else the first team you are on.
 */
export function GithubSettings() {
  const teams = useTeams().data;
  const [params, setParams] = useSearchParams();
  const wanted = params.get("team");
  const team = teams?.find((t) => t.key === wanted) ?? teams?.[0];
  return (
    <div className="space-y-2">
      {teams && teams.length > 1 && team && (
        <div className="flex justify-end">
          <Select
            ariaLabel="Team"
            value={team.key}
            options={teams.map((t) => ({ value: t.key, label: t.name }))}
            onValueChange={(key) => setParams({ team: key })}
          />
        </div>
      )}
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
