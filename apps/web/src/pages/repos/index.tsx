import { useParams } from "react-router";
import { Loaded } from "../../components/query-state";
import { useRepos } from "../../lib/queries";
import { GithubConnect } from "./github-connect";
import { Repos } from "./repos";

/** `/p/:key/repos`: the repositories behind the project, and connecting GitHub. */
export function ReposPage() {
  const { key = "" } = useParams();
  const query = useRepos(key);
  return (
    <Loaded query={query} label="Loading repositories">
      {(repos) => <Repos projectKey={key} repos={repos} after={<GithubConnect projectKey={key} />} />}
    </Loaded>
  );
}
