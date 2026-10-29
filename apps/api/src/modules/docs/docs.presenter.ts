import { ServiceError } from "../../common/service-error";
import type { DocRow } from "./docs.repository";

/** A doc in the tree: what the page lists, without the body. */
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

/** A drawing in the grid: no scene body. */
export type DrawingListItem = { id: string; slug: string; title: string; version: number; updatedAt: Date; thumbnail: string | null };

/** A whole drawing: `body` is the Excalidraw scene JSON. */
export type DrawingView = DocView & { kind: "drawing"; thumbnail: string | null };

export const drawingView = (d: DocRow): DrawingView => ({ ...docView(d), kind: "drawing", thumbnail: d.thumbnail });

/** A doc row as the API shows it. */
export const docView = (d: DocRow): DocView => ({
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

/** The docs page in one read: the tree, the map nodes and decisions its side panels offer, and the workspace's people. */
export const docsIndexView = (idx: { docs: DocTreeItem[]; nodes: { id: string; name: string; layer: string; parentId: string | null }[]; decisions: { id: string; number: number; title: string }[]; members: { id: string; name: string }[] }) => ({
  docs: idx.docs,
  nodes: idx.nodes.map(({ id, name, layer, parentId }) => ({ id, name, layer, parentId })),
  decisions: idx.decisions.map(({ id, number, title }) => ({ id, number, title })),
  members: idx.members,
});

/** Same as `withCurrentDoc`, with the current drawing (thumbnail included) in `details.current`. */
export async function withCurrentDrawing<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof ServiceError && e.code === "conflict") {
      const raw = (e.details as { current?: DocRow } | undefined)?.current;
      if (raw) throw new ServiceError("conflict", e.message, { current: drawingView(raw) });
    }
    throw e;
  }
}

/** A stale `version` is a 409 whose `details.current` is the doc as it is now, in the same trimmed shape as every other answer. */
export async function withCurrentDoc<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof ServiceError && e.code === "conflict") {
      const raw = (e.details as { current?: DocRow } | undefined)?.current;
      if (raw) throw new ServiceError("conflict", e.message, { current: docView(raw) });
    }
    throw e;
  }
}
