import { useParams } from "react-router";
import { Loaded } from "../../components/query-state";
import { useDocs } from "../../lib/queries";
import { DocsExplorer } from "./docs-explorer";

/** `/t/:key/docs`: the team's documentation, a screen listing every doc; `/t/:key/docs/:docId` is one doc, with the doc tree in a sheet. */
export function DocsPage() {
  const { key = "", docId } = useParams();
  const query = useDocs(key);
  return (
    <Loaded query={query} label="Loading docs">
      {(index) => <DocsExplorer teamKey={key} index={index} docId={docId} />}
    </Loaded>
  );
}
