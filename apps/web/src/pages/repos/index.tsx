import { useParams } from "react-router";
import { Loaded } from "../../components/query-state";
import { useRepos } from "../../lib/queries";
import { GithubConnect } from "./github-connect";
import { Repos } from "./repos";

/** `/t/:key/repos`: the repositories behind the team, and connecting GitHub. */
export function ReposPage() {
  const { key = "" } = useParams();
  const query = useRepos(key);
  return (
    <Loaded query={query} label="Loading repositories">
      {(repos) => <Repos teamKey={key} repos={repos} after={<GithubConnect teamKey={key} />} />}
    </Loaded>
  );
}
