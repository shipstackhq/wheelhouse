import { useParams } from "react-router";
import { Loaded } from "../../components/query-state";
import { useDocs } from "../../lib/queries";
import { DocsExplorer } from "./docs-explorer";

/** `/p/:key/docs`: the project's documentation, a tree of docs with a rich-text editor. */
export function DocsPage() {
  const { key = "" } = useParams();
  const query = useDocs(key);
  return (
    <Loaded query={query} label="Loading docs">
      {(index) => <DocsExplorer projectKey={key} index={index} />}
    </Loaded>
  );
}
