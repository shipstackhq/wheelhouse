import { and, eq } from "drizzle-orm";
import { getDb, schema } from "../../db";
import type { Actor } from "../../common/actor";
import { emit } from "../../platform/events/emit";
import { resolveNode } from "../map/index";
import { resolveIssue } from "./issues";

const { issueNodes } = schema;

/** Link an issue to a map node, or unlink it. This module owns issue_nodes: the table is written only from an issue. */
export async function linkIssueNode(actor: Actor, issueRef: string, nodeRef: string, unlink = false) {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const { issue, team, ref } = await resolveIssue(actor, issueRef, tx, "edit");
    const n = await resolveNode(tx, team.id, nodeRef);
    if (unlink) {
      await tx.delete(issueNodes).where(and(eq(issueNodes.issueId, issue.id), eq(issueNodes.nodeId, n.id)));
    } else {
      await tx.insert(issueNodes).values({ issueId: issue.id, nodeId: n.id }).onConflictDoNothing();
    }
    await emit(tx, actor, team.id, {
      type: unlink ? "issue.unlinked" : "issue.linked",
      entity: "issue",
      entityId: issue.id,
      summary: `${unlink ? "unlinked" : "linked"} ${ref} ${unlink ? "from" : "to"} "${n.name}"`,
      data: { ref, node: n.name },
    });
    return { ok: true };
  });
}
