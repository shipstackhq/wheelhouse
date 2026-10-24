import { Injectable } from "@nestjs/common";
import { deleteTerm } from "./decisions";
import { markFresh } from "./freshness";
import { deleteEdge, deleteFlow, deleteNode } from "./graph";
import { activityView, askAs, connectAs, graphView, saveLayoutAs, upsertDecisionAs, upsertFlowAs, upsertNodeAs, upsertTermAs } from "./map-app";
import { resolveDraft } from "./sync";

/**
 * What the map area (the knowledge map, its decisions and glossary, drafts and the briefing) can do, as the one door to it: the
 * controller (and, later, other modules through this module's index.ts) calls this, never the functions in this folder
 * directly. For now each method hands over to the function of the same name with the same arguments and answer; folding the
 * functions into service methods can wait (docs/nest-architecture.md).
 */
@Injectable()
export class MapService {
  activityView(...a: Parameters<typeof activityView>) {
    return activityView(...a);
  }
  askAs(...a: Parameters<typeof askAs>) {
    return askAs(...a);
  }
  connectAs(...a: Parameters<typeof connectAs>) {
    return connectAs(...a);
  }
  deleteEdge(...a: Parameters<typeof deleteEdge>) {
    return deleteEdge(...a);
  }
  deleteFlow(...a: Parameters<typeof deleteFlow>) {
    return deleteFlow(...a);
  }
  deleteNode(...a: Parameters<typeof deleteNode>) {
    return deleteNode(...a);
  }
  deleteTerm(...a: Parameters<typeof deleteTerm>) {
    return deleteTerm(...a);
  }
  graphView(...a: Parameters<typeof graphView>) {
    return graphView(...a);
  }
  markFresh(...a: Parameters<typeof markFresh>) {
    return markFresh(...a);
  }
  resolveDraft(...a: Parameters<typeof resolveDraft>) {
    return resolveDraft(...a);
  }
  saveLayoutAs(...a: Parameters<typeof saveLayoutAs>) {
    return saveLayoutAs(...a);
  }
  upsertDecisionAs(...a: Parameters<typeof upsertDecisionAs>) {
    return upsertDecisionAs(...a);
  }
  upsertFlowAs(...a: Parameters<typeof upsertFlowAs>) {
    return upsertFlowAs(...a);
  }
  upsertNodeAs(...a: Parameters<typeof upsertNodeAs>) {
    return upsertNodeAs(...a);
  }
  upsertTermAs(...a: Parameters<typeof upsertTermAs>) {
    return upsertTermAs(...a);
  }
}
