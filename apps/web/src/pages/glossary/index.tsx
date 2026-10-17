import { useParams } from "react-router";
import { Loaded } from "../../components/query-state";
import { useGraph } from "../../lib/queries";
import { Glossary } from "./glossary";

/** `/p/:key/glossary`: the project's vocabulary, each term optionally tied to a concept on the map. */
export function GlossaryPage() {
  const { key = "" } = useParams();
  const query = useGraph(key);
  return (
    <Loaded query={query} label="Loading the glossary">
      {(g) => <Glossary projectKey={g.project.key} terms={g.terms} nodes={g.nodes.filter((n) => n.layer === "concept").map(({ id, name }) => ({ id, name }))} />}
    </Loaded>
  );
}
