import { Injectable } from "@nestjs/common";
import { deleteDoc, linkDocNode, suggestDocAnchors } from "../../lib/service";
import { createDocAs, docsIndex, getDocAs, markDocFreshAs, moveDocAs, updateDocAs } from "./docs-app";

/**
 * What the docs area can do, as the one door to it: the controller (and, later, other modules through this module's index.ts)
 * calls this, never the functions in this folder directly. For now each method hands over to the function of the same name
 * with the same arguments and answer; folding the functions into service methods can wait (docs/nest-architecture.md).
 */
@Injectable()
export class DocsService {
  createDocAs(...a: Parameters<typeof createDocAs>) {
    return createDocAs(...a);
  }
  deleteDoc(...a: Parameters<typeof deleteDoc>) {
    return deleteDoc(...a);
  }
  docsIndex(...a: Parameters<typeof docsIndex>) {
    return docsIndex(...a);
  }
  getDocAs(...a: Parameters<typeof getDocAs>) {
    return getDocAs(...a);
  }
  linkDocNode(...a: Parameters<typeof linkDocNode>) {
    return linkDocNode(...a);
  }
  markDocFreshAs(...a: Parameters<typeof markDocFreshAs>) {
    return markDocFreshAs(...a);
  }
  moveDocAs(...a: Parameters<typeof moveDocAs>) {
    return moveDocAs(...a);
  }
  suggestDocAnchors(...a: Parameters<typeof suggestDocAnchors>) {
    return suggestDocAnchors(...a);
  }
  updateDocAs(...a: Parameters<typeof updateDocAs>) {
    return updateDocAs(...a);
  }
}
