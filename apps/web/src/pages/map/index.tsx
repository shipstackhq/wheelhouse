import { useParams, useSearchParams } from "react-router";
import { Loaded } from "../../components/query-state";
import { useGraph } from "../../lib/queries";
import { KnowledgeMap } from "./knowledge-map";

/** `/p/:key/map`: the knowledge map. `?lens=`, `?node=` and `?flow=` open it on a layer, a node or a flow (and are kept up to date as you move around). */
export function MapPage() {
  const { key = "" } = useParams();
  const [search] = useSearchParams();
  const query = useGraph(key);
  return (
    <Loaded query={query} label="Loading the map" rows={4}>
      {(graph) => (
        <KnowledgeMap
          projectKey={graph.project.key}
          graph={graph}
          initialNode={search.get("node") ?? undefined}
          initialFlow={search.get("flow") ?? undefined}
          initialLens={search.get("lens") ?? undefined}
        />
      )}
    </Loaded>
  );
}
