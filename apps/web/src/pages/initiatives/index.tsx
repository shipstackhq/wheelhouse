import { useParams } from "react-router";
import { Loaded } from "../../components/query-state";
import { useInitiative, useInitiatives } from "../../lib/queries";
import { Initiatives } from "./initiatives";
import { InitiativeView } from "./initiative-view";

/** `/initiatives`: every initiative of the workspace, nested. */
export function InitiativesPage() {
  const query = useInitiatives();
  return (
    <Loaded query={query} label="Loading initiatives">
      {(initiatives) => <Initiatives initiatives={initiatives} />}
    </Loaded>
  );
}

/** `/initiatives/:id`: one initiative, its sub-initiatives and projects. */
export function InitiativePage() {
  const { id = "" } = useParams();
  const query = useInitiative(id);
  return (
    <Loaded query={query} label="Loading the initiative">
      {(initiative) => <InitiativeView initiative={initiative} />}
    </Loaded>
  );
}
