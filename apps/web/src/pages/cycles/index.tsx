import { useParams } from "react-router";
import { NotFound } from "../../routes/errors";
import { Loaded } from "../../components/query-state";
import { useCycle, useCycles } from "../../lib/queries";
import { CycleView } from "./cycle-view";
import { Cycles } from "./cycles";

/** `/t/:key/cycles`: the team's cycles, the current one first, then the next ones and the ones behind it. */
export function CyclesPage() {
  const { key = "" } = useParams();
  const query = useCycles(key);
  return (
    <Loaded query={query} label="Loading cycles">
      {(list) => <Cycles teamKey={key} list={list} />}
    </Loaded>
  );
}

/** `/t/:key/cycles/:number`: one cycle, its tickets, and what landed while it ran. */
export function CyclePage() {
  const { key = "", number = "" } = useParams();
  const n = /^\d{1,9}$/.test(number) ? Number(number) : null;
  const query = useCycle(key, n ?? 0);
  if (n === null) return <NotFound />;
  return (
    <Loaded query={query} label="Loading the cycle">
      {(cycle) => <CycleView teamKey={key} cycle={cycle} />}
    </Loaded>
  );
}
