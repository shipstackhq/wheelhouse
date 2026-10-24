import { eq } from "drizzle-orm";
import { getDb, schema } from "../../db";
import type { Actor } from "../../common/actor";
import type { Human } from "../../lib/auth-core";
import { DOC_TEMPLATE_IDS } from "@wheelhouse/shared/doc-templates";
import * as svc from "../../lib/service";
import { ServiceError } from "../../lib/service";
import { bad, oneOf, text, textList, textOrNull, whole } from "../../lib/web-input";

/**
 * What the web app's docs, repositories and onboarding pages read and write (WH-98), as functions of the signed-in person.
 * The API's controllers call these and nothing else. Everything goes through the service layer, which scopes it by the person's
 * workspace, so another workspace's team, doc or repository is "not found". Answers carry only what the screens use.
 */

type Body = Record<string, unknown>;

// ───────── docs ─────────

export type DocTreeItem = { id: string; parentId: string | null; slug: string; title: string; version: number; position: number; updatedAt: Date; stale: boolean };

export type DocView = DocTreeItem & {
  body: string;
  anchors: string[];
  labels: string[];
  staleReason: string | null;
  updatedByKind: "human" | "agent";
  updatedById: string | null;
  createdAt: Date;
};

export const docView = (d: typeof schema.docs.$inferSelect): DocView => ({
  id: d.id,
  parentId: d.parentId,
  slug: d.slug,
  title: d.title,
  version: d.version,
  position: d.position,
  updatedAt: d.updatedAt,
  stale: d.stale,
  body: d.body,
  anchors: d.anchors,
  labels: d.labels,
  staleReason: d.staleReason,
  updatedByKind: d.updatedByKind,
  updatedById: d.updatedById,
  createdAt: d.createdAt,
});

/** A stale `version` is a 409 whose `details.current` is the doc as it is now, in the same trimmed shape as every other answer. */
async function withCurrent<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof ServiceError && e.code === "conflict") {
      const raw = (e.details as { current?: typeof schema.docs.$inferSelect } | undefined)?.current;
      if (raw) throw new ServiceError("conflict", e.message, { current: docView(raw) });
    }
    throw e;
  }
}

/** The docs page in one read: the tree, and what its side panels offer (map nodes to link, decisions to link, who wrote what). */
export async function docsIndex(h: Human, teamKey: string) {
  const [docs, g] = await Promise.all([svc.listDocs(h.actor, teamKey), svc.getGraph(h.actor, teamKey)]);
  const db = await getDb();
  const members = await db
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(eq(schema.memberships.workspaceId, h.workspace.id));
  return {
    docs: docs as DocTreeItem[],
    nodes: g.nodes.map(({ id, name, layer, parentId }) => ({ id, name, layer, parentId })),
    decisions: g.decisions.map(({ id, number, title }) => ({ id, number, title })),
    members,
  };
}

export async function getDocAs(actor: Actor, teamKey: string, ref: string) {
  const { doc, nodes, owner, contributors } = await svc.getDoc(actor, teamKey, ref);
  return { doc: docView(doc), nodes, owner, contributors };
}

export async function createDocAs(actor: Actor, teamKey: string, b: Body): Promise<DocView> {
  const title = text(b, "title", { required: true, max: 300, trim: true })!;
  const input: svc.DocInput & { title: string } = {
    title,
    body: text(b, "body"),
    parent: textOrNull(b, "parent"),
    template: oneOf(b, "template", DOC_TEMPLATE_IDS),
  };
  return docView(await svc.createDoc(actor, teamKey, input));
}

/** `version` is the lock: a change made since is a 409 and nothing is overwritten. */
export async function updateDocAs(actor: Actor, teamKey: string, ref: string, b: Body): Promise<DocView> {
  const anchors = textList(b, "anchors");
  const patch = {
    title: text(b, "title", { max: 300 }),
    body: text(b, "body"),
    anchors: anchors?.map((a) => a.trim()).filter(Boolean),
    labels: textList(b, "labels"),
  };
  if (patch.title !== undefined && !patch.title.trim()) bad("title", "title is required");
  return docView(await withCurrent(() => svc.updateDoc(actor, teamKey, ref, patch, whole(b, "version"))));
}

export async function markDocFreshAs(actor: Actor, teamKey: string, ref: string): Promise<DocView> {
  return docView(await svc.markDocFresh(actor, teamKey, ref));
}

export async function moveDocAs(actor: Actor, teamKey: string, ref: string, b: Body): Promise<DocView> {
  const opts = { parent: textOrNull(b, "parent"), index: whole(b, "index") };
  return docView(await withCurrent(() => svc.moveDoc(actor, teamKey, ref, opts, whole(b, "version"))));
}
