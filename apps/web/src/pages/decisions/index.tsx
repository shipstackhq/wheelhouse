import { useParams } from "react-router";
import { Loaded } from "../../components/query-state";
import { useGraph } from "../../lib/queries";
import { Decisions } from "./decisions";

/** `/t/:key/decisions` (and `/decisions/:number` for one): the team's ADRs (read from the map: they hang off its nodes). */
export function DecisionsPage() {
  const { key = "", number } = useParams();
  const query = useGraph(key);
  return (
    <Loaded query={query} label="Loading the decisions">
      {(g) => (
        <Decisions
          teamKey={g.team.key}
          number={number === undefined ? undefined : Number(number)}
          decisions={g.decisions}
          nodes={g.nodes.map(({ id, name, layer }) => ({ id, name, layer }))}
          terms={g.terms.map(({ term, definition }) => ({ term, definition }))}
        />
      )}
    </Loaded>
  );
}
