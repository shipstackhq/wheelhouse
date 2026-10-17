import { useParams } from "react-router";
import { Loaded } from "../../components/query-state";
import { useDocs } from "../../lib/queries";
import { DocsExplorer } from "./docs-explorer";

/** `/p/:key/docs`: the project's documentation, a screen listing every doc; `/p/:key/docs/:docId` is one doc, with the doc tree in a sheet. */
export function DocsPage() {
  const { key = "", docId } = useParams();
  const query = useDocs(key);
  return (
    <Loaded query={query} label="Loading docs">
      {(index) => <DocsExplorer projectKey={key} index={index} docId={docId} />}
    </Loaded>
  );
}
