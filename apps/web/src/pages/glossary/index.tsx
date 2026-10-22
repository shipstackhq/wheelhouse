import { useParams } from "react-router";
import { Loaded } from "../../components/query-state";
import { useGraph } from "../../lib/queries";
import { Glossary } from "./glossary";

/** `/t/:key/glossary` (and `/glossary/:termId` for one term): the team's vocabulary, each term optionally tied to a concept on the map. */
export function GlossaryPage() {
  const { key = "", termId } = useParams();
  const query = useGraph(key);
  return (
    <Loaded query={query} label="Loading the glossary">
      {(g) => <Glossary teamKey={g.team.key} termId={termId} terms={g.terms} nodes={g.nodes.filter((n) => n.layer === "concept").map(({ id, name }) => ({ id, name }))} />}
    </Loaded>
  );
}
