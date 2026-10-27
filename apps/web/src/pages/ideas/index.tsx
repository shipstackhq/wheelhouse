import { useParams } from "react-router";
import { Loaded } from "../../components/query-state";
import { useIdea, useIdeas } from "../../lib/queries";
import { Ideas } from "./ideas";
import { IdeaView } from "./idea-view";

/** `/ideas`: every idea of the workspace, newest first. */
export function IdeasPage() {
  const query = useIdeas();
  return (
    <Loaded query={query} label="Loading ideas">
      {(ideas) => <Ideas ideas={ideas} />}
    </Loaded>
  );
}

/** `/ideas/:id`: one idea, its comments, and Promote. */
export function IdeaPage() {
  const { id = "" } = useParams();
  const query = useIdea(id);
  return (
    <Loaded query={query} label="Loading the idea">
      {(idea) => <IdeaView idea={idea} />}
    </Loaded>
  );
}
