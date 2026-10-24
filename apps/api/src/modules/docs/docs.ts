import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { getDb, schema } from "../../db";
import type { Actor } from "../../lib/access";
import { getDocTemplate, listDocTemplates as listDocTemplatesStatic } from "@wheelhouse/shared/doc-templates";
import { ServiceError } from "../../lib/service-error";
import { cleanLabels } from "../../lib/links";
import { Q, diff, emit, isUuid, lockRow } from "../../lib/service-core";
import { normPath } from "../map/freshness";
import { landedHashesFor, resolveNode } from "../map/graph";
import { requireTeam } from "../teams/teams";

const { nodes, events, docs, docNodes, apiKeys, users } = schema;

// ───────────────────────── workspace documentation (WH-51) ─────────────────────────
//
// Markdown docs stored in Wheelhouse, next to the board and map: runbooks, product
// notes, conventions, onboarding, decisions in prose. A tree via parentId, optimistic
// locking like issues, soft delete (30-day purge; history lives in `events`). Reading
// is open to any key; writing (upsertDoc/deleteDoc/moveDoc) requires a human actor or
// a key with the "docs:write" capability — enforced here, and again at the tool layer
// so a future caller of these functions can't skip the check by mistake.

export const DOC_BODY_MAX_BYTES = 200_000; // 200 KB
export const DOC_MAX_DEPTH = 4;
export const DOC_MAX_PER_TEAM = 500;

export type DocRow = typeof docs.$inferSelect;

/** Humans can always write docs; agent keys need the "docs:write" capability. */
export function canWriteDocs(actor: Actor, capabilities?: string[]) {
  if (actor.kind === "human") return true;
  return (capabilities ?? []).includes("docs:write");
}

export async function assertDocsWritable(actor: Actor, q: Q) {
  if (actor.kind === "human") return;
  const [key] = await q.select({ capabilities: apiKeys.capabilities }).from(apiKeys).where(eq(apiKeys.id, actor.id));
  if (!canWriteDocs(actor, key?.capabilities)) {
    throw new ServiceError("forbidden", 'This API key cannot write docs. Ask a teammate to grant it the "docs:write" capability, or write docs as a human.');
  }
}

/** Accepts a doc uuid, or a "slug" / "parent-slug/slug" path, scoped to one team. Never returns a soft-deleted doc. */
export async function resolveDoc(q: Q, teamId: string, ref: string) {
  if (isUuid(ref)) {
    const [d] = await q.select().from(docs).where(and(eq(docs.id, ref), eq(docs.teamId, teamId), isNull(docs.deletedAt)));
    if (!d) throw new ServiceError("not_found", `Doc ${ref} not found`);
    return d;
  }
  // Walk a "/"-separated slug path from the root.
  const parts = ref.split("/").filter(Boolean);
  if (!parts.length) throw new ServiceError("invalid", "Doc ref is required");
  let parentId: string | null = null;
  let found: DocRow | undefined;
  for (const slug of parts) {
    const [d] = await q
      .select()
      .from(docs)
      .where(and(eq(docs.teamId, teamId), eq(docs.slug, slug), isNull(docs.deletedAt), parentId === null ? isNull(docs.parentId) : eq(docs.parentId, parentId)));
    if (!d) throw new ServiceError("not_found", `Doc "${ref}" not found`);
    found = d;
    parentId = d.id;
  }
  return found!;
}

export function slugifyDoc(title: string) {
  return (
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "doc"
  );
}

/** Depth of `parentId` itself (root = 0), by walking up its own ancestor chain. */
export async function depthOf(q: Q, teamId: string, parentId: string | null): Promise<number> {
  let depth = 0;
  let cur = parentId;
  while (cur) {
    const [p] = await q.select({ parentId: docs.parentId }).from(docs).where(and(eq(docs.id, cur), eq(docs.teamId, teamId)));
    if (!p) break;
    cur = p.parentId;
    if (cur) depth += 1; // only count a hop to another ancestor, not the starting node itself
    if (depth > DOC_MAX_DEPTH + 1) break; // guard against a cycle somehow sneaking in
  }
  return depth;
}

export async function uniqueSlug(q: Q, teamId: string, parentId: string | null, base: string, excludeId?: string) {
  let slug = base;
  for (let i = 1; i < 50; i++) {
    const [clash] = await q
      .select({ id: docs.id })
      .from(docs)
      .where(
        and(
          eq(docs.teamId, teamId),
          eq(docs.slug, slug),
          isNull(docs.deletedAt),
          parentId === null ? isNull(docs.parentId) : eq(docs.parentId, parentId),
          excludeId ? ne(docs.id, excludeId) : undefined,
        ),
      );
    if (!clash) return slug;
    slug = `${base}-${i + 1}`;
  }
  throw new ServiceError("conflict", `Could not find a free slug for "${base}"`);
}

export type DocInput = {
  title?: string;
  body?: string;
  parent?: string | null; // parent doc ref (uuid or slug path); null = top level
  slug?: string; // explicit slug override; defaults to slugify(title)
  anchors?: string[]; // author-confirmed file paths/globs this doc describes (WH-64 freshness)
  describedSha?: string;
  markFresh?: boolean; // clear stale without changing title/body, recording who confirmed via updatedByKind/updatedById
  template?: string; // WH-65: template id to seed `body` from on create, if no explicit body is given
};

/**
 * Lightweight heuristic (WH-64, scope B): pull file-path-looking tokens out of a doc's
 * Markdown — inline code spans (`` `src/lib/x.ts` ``) and bare tokens that look like a
 * repo-relative path (contain a "/" and end in a plausible extension, or end in "/" for
 * a directory). Not an NLP system — a few false negatives/positives are fine, since the
 * issue says these are SUGGESTIONS the author confirms, never auto-applied.
 */
export const PATH_TOKEN_RE = /[A-Za-z0-9_.*-]+(?:\/[A-Za-z0-9_.*-]+)+\/?/g;
export const LIKELY_PATH_RE = /^(?:[A-Za-z0-9_.-]+\/)+(?:[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}|\*\*?|[A-Za-z0-9_.*-]+)\/?$/;

export function extractPathTokens(markdown: string): string[] {
  const codeSpans = [...markdown.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  const bare = [...markdown.matchAll(PATH_TOKEN_RE)].map((m) => m[0]);
  const candidates = [...codeSpans, ...bare].map((s) => s.trim().replace(/[.,;:!?)]+$/, "")).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    const p = normPath(c);
    if (!LIKELY_PATH_RE.test(p) && !/[*?]/.test(p)) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/**
 * Candidate anchors for a doc: path-like tokens found in its body, plus the anchors of
 * any map nodes it's linked to. Never applied automatically — surfaced for the author
 * to accept/reject (upsert_doc / the docs UI pass `anchors` explicitly to confirm them).
 */
export async function suggestDocAnchors(actor: Actor, teamRef: string, ref: string): Promise<string[]> {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef);
  const d = await resolveDoc(db, team.id, ref);
  const fromBody = extractPathTokens(d.body);
  const linkedNodeIds = await db.select({ nodeId: docNodes.nodeId }).from(docNodes).where(eq(docNodes.docId, d.id));
  const fromNodes = linkedNodeIds.length
    ? (await db.select({ anchors: nodes.anchors }).from(nodes).where(inArray(nodes.id, linkedNodeIds.map((x) => x.nodeId)))).flatMap((n) => n.anchors)
    : [];
  return [...new Set([...fromBody, ...fromNodes])].filter((a) => !d.anchors.includes(a));
}

/** Static list of the five doc templates (id/name/description, no bodies) — no DB access needed. */
export function listDocTemplates() {
  return listDocTemplatesStatic();
}

/** The tree of a team's (non-deleted) docs: id, slug, title, parentId, position, updatedAt. */
export async function listDocs(actor: Actor, teamRef: string, parentRef?: string) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef);
  const parentId = parentRef ? (await resolveDoc(db, team.id, parentRef)).id : undefined;
  const rows = await db
    .select({
      id: docs.id,
      parentId: docs.parentId,
      slug: docs.slug,
      title: docs.title,
      version: docs.version,
      position: docs.position,
      updatedAt: docs.updatedAt,
      stale: docs.stale,
    })
    .from(docs)
    .where(and(eq(docs.teamId, team.id), isNull(docs.deletedAt)))
    .orderBy(asc(docs.position));
  if (parentRef !== undefined) return rows.filter((d) => d.parentId === parentId);
  return rows;
}

export async function getDoc(actor: Actor, teamRef: string, ref: string) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef);
  const d = await resolveDoc(db, team.id, ref);
  const linked = await db
    .select({ id: nodes.id, name: nodes.name, kind: nodes.kind, layer: nodes.layer })
    .from(docNodes)
    .innerJoin(nodes, eq(nodes.id, docNodes.nodeId))
    .where(eq(docNodes.docId, d.id));
  // Who wrote it (WH-103): the owner is whoever created the doc; contributors are everyone else who changed it, from the event log
  // (which keeps the name they had at the time, so an agent or a person who has left still has one).
  const touched = await db
    .select({ type: events.type, actorKind: events.actorKind, actorId: events.actorId, actorName: events.actorName })
    .from(events)
    .where(and(eq(events.workspaceId, team.workspaceId), eq(events.entity, "doc"), eq(events.entityId, d.id), inArray(events.type, ["doc.created", "doc.updated"])))
    .orderBy(asc(events.seq));
  const created = touched.find((e) => e.type === "doc.created");
  const [owner] = d.createdByKind === "human" && d.createdById ? await db.select({ name: users.name }).from(users).where(eq(users.id, d.createdById)) : [];
  const ownerName = owner?.name ?? created?.actorName ?? (d.createdByKind === "agent" ? "Agent" : "Someone");
  const seenPeople = new Set([`${d.createdByKind}:${d.createdById}`]);
  const contributors: { kind: "human" | "agent"; id: string | null; name: string }[] = [];
  for (const e of touched) {
    const k = `${e.actorKind}:${e.actorId}`;
    if (seenPeople.has(k)) continue;
    seenPeople.add(k);
    contributors.push({ kind: e.actorKind, id: e.actorId, name: e.actorName });
  }
  return { doc: d, nodes: linked, owner: { kind: d.createdByKind, id: d.createdById, name: ownerName }, contributors };
}

export async function createDoc(actor: Actor, teamRef: string, input: DocInput & { title: string }) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  await assertDocsWritable(actor, db);
  if (!input.title?.trim()) throw new ServiceError("invalid", "title is required");
  // WH-65: explicit body always wins; the template is only a convenience default for a blank doc.
  const body = input.body ?? getDocTemplate(input.template)?.body ?? "";
  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (bodyBytes > DOC_BODY_MAX_BYTES) throw new ServiceError("invalid", `Doc body is ${bodyBytes} bytes; the limit is ${DOC_BODY_MAX_BYTES} (200 KB)`);

  return db.transaction(async (tx) => {
    const parentId = input.parent === null || input.parent === undefined ? null : (await resolveDoc(tx, team.id, input.parent)).id;
    const depth = await depthOf(tx, team.id, parentId);
    if (depth + 1 > DOC_MAX_DEPTH) throw new ServiceError("invalid", `Docs can nest at most ${DOC_MAX_DEPTH} levels deep`);
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(docs).where(and(eq(docs.teamId, team.id), isNull(docs.deletedAt)));
    if (n >= DOC_MAX_PER_TEAM) throw new ServiceError("invalid", `This team already has ${DOC_MAX_PER_TEAM} docs, the limit`);

    const base = slugifyDoc(input.slug ?? input.title);
    const slug = await uniqueSlug(tx, team.id, parentId, base);
    const siblings = await tx.select({ position: docs.position }).from(docs).where(and(eq(docs.teamId, team.id), isNull(docs.deletedAt), parentId === null ? isNull(docs.parentId) : eq(docs.parentId, parentId)));
    const position = siblings.length ? Math.max(...siblings.map((s) => s.position)) + 1000 : 1000;

    const anchors = input.anchors ?? [];
    const [d] = await tx
      .insert(docs)
      .values({
        teamId: team.id,
        workspaceId: team.workspaceId,
        parentId,
        slug,
        title: input.title.trim(),
        body,
        position,
        anchors,
        describedHashes: await landedHashesFor(tx, team.id, anchors),
        describedSha: input.describedSha ?? null,
        describedAt: new Date(),
        createdByKind: actor.kind,
        createdById: actor.id,
        updatedByKind: actor.kind,
        updatedById: actor.id,
      })
      .returning();
    await emit(tx, actor, team.id, {
      type: "doc.created",
      entity: "doc",
      entityId: d.id,
      summary: `created doc "${d.title}"`,
      data: { slug: d.slug, title: d.title },
    });
    return d;
  });
}

export type DocUpdateInput = Pick<DocInput, "title" | "body" | "anchors" | "describedSha" | "markFresh"> & {
  labels?: string[]; // WH-103: free-text tags; they never affect freshness
  forcePublish?: boolean; // skip the in-flux draft check (used when publishing a draft on land)
  describedHashes?: Record<string, string>; // content hashes the edit/confirmation was made against
};

/**
 * Patch a doc's title/body/anchors, or just confirm it's still accurate (markFresh).
 * Pass `expectedVersion` for optimistic locking, same pattern as updateIssue.
 *
 * Mirrors upsertNode: an agent session editing a doc whose anchored files are still
 * in flux (changed in that same session, not landed) gets the edit stored as a
 * doc_drafts row instead of applied directly — published when land() processes
 * those files (WH-64 scope E).
 */
/** Labels as stored: trimmed, no empties or repeats (case-insensitively, first spelling wins), at most 20 of at most 40 characters. */
export const cleanDocLabels = (labels: string[]) => cleanLabels(labels, "doc");

export async function updateDoc(actor: Actor, teamRef: string, ref: string, patch: DocUpdateInput, expectedVersion?: number) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  await assertDocsWritable(actor, db);
  if (patch.body !== undefined) {
    const bodyBytes = Buffer.byteLength(patch.body, "utf8");
    if (bodyBytes > DOC_BODY_MAX_BYTES) throw new ServiceError("invalid", `Doc body is ${bodyBytes} bytes; the limit is ${DOC_BODY_MAX_BYTES} (200 KB)`);
  }

  if (actor.kind === "agent" && !patch.forcePublish) {
    const existing = await resolveDoc(db, team.id, ref).catch(() => undefined);
    if (existing) {
      const { maybeDraftDoc } = await import("../map/sync");
      const d = await maybeDraftDoc(actor, existing, patch);
      if (d) return { ...existing, ...d };
    }
  }

  return db.transaction(async (tx) => {
    const d = await lockRow(tx, docs, await resolveDoc(tx, team.id, ref));
    if (expectedVersion !== undefined && expectedVersion !== d.version) {
      throw new ServiceError("conflict", `Doc "${d.title}" was changed (version ${d.version}, you had ${expectedVersion}). Re-read and retry.`, { current: d });
    }
    const clean: Record<string, unknown> = {};
    if (patch.title !== undefined) clean.title = patch.title.trim();
    if (patch.body !== undefined) clean.body = patch.body;
    if (patch.anchors !== undefined) clean.anchors = patch.anchors;
    if (patch.labels !== undefined) clean.labels = cleanDocLabels(patch.labels);
    const changes = diff(d as unknown as Record<string, unknown>, clean);
    // Editing title/body/anchors, or an explicit confirm (mark_doc_fresh-equivalent), clears staleness —
    // same rule as upsertNode's EXPLAINER_FIELDS/anchors/markFresh check.
    const described = "title" in changes || "body" in changes || "anchors" in changes || patch.markFresh || patch.describedSha;
    const fresh = described
      ? {
          stale: false,
          staleReason: null,
          staleSource: null,
          driftPaths: [],
          describedHashes: patch.describedHashes ?? (await landedHashesFor(tx, team.id, patch.anchors ?? d.anchors)),
          describedAt: new Date(),
          describedSha: patch.describedSha ?? d.describedSha,
        }
      : {};
    if (!Object.keys(changes).length && !described) return d;
    const [updated] = await tx
      .update(docs)
      .set({ ...clean, ...fresh, version: d.version + 1, updatedAt: new Date(), updatedByKind: actor.kind, updatedById: actor.id })
      .where(eq(docs.id, d.id))
      .returning();
    const meaningful = Object.keys(changes);
    if (meaningful.length || (d.stale && described)) {
      await emit(tx, actor, team.id, {
        type: "doc.updated",
        entity: "doc",
        entityId: updated.id,
        summary: `updated doc "${updated.title}"${meaningful.length ? `: ${meaningful.join(", ")}` : ""}${d.stale && described ? " (now fresh)" : ""}`,
        data: { slug: updated.slug, changes: meaningful },
      });
    }
    return updated;
  });
}

/** Clear a doc's stale flag after confirming it's still accurate (no edits needed) — mirrors markFresh for nodes. */
export async function markDocFresh(actor: Actor, teamRef: string, ref: string, sha?: string) {
  return updateDoc(actor, teamRef, ref, { markFresh: true, describedSha: sha });
}

/** Move a doc to a new parent and/or position among its siblings. */
export async function moveDoc(actor: Actor, teamRef: string, ref: string, opts: { parent?: string | null; index?: number }, expectedVersion?: number) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  await assertDocsWritable(actor, db);
  return db.transaction(async (tx) => {
    const d = await lockRow(tx, docs, await resolveDoc(tx, team.id, ref));
    if (expectedVersion !== undefined && expectedVersion !== d.version) {
      throw new ServiceError("conflict", `Doc "${d.title}" was changed since you read it`, { current: d });
    }
    const parentId = opts.parent === undefined ? d.parentId : opts.parent === null ? null : (await resolveDoc(tx, team.id, opts.parent)).id;
    if (parentId === d.id) throw new ServiceError("invalid", "A doc cannot be its own parent");
    // Prevent cycles: the new parent can't be one of this doc's own descendants.
    if (parentId) {
      let cur: string | null = parentId;
      while (cur) {
        if (cur === d.id) throw new ServiceError("invalid", "Can't move a doc under one of its own descendants");
        const [p] = await tx.select({ parentId: docs.parentId }).from(docs).where(eq(docs.id, cur));
        cur = p?.parentId ?? null;
      }
    }
    if (parentId !== d.parentId) {
      const depth = await depthOf(tx, team.id, parentId);
      if (depth + 1 > DOC_MAX_DEPTH) throw new ServiceError("invalid", `Docs can nest at most ${DOC_MAX_DEPTH} levels deep`);
    }
    const slug = parentId !== d.parentId ? await uniqueSlug(tx, team.id, parentId, d.slug, d.id) : d.slug;
    const siblings = await tx
      .select({ id: docs.id, position: docs.position })
      .from(docs)
      .where(and(eq(docs.teamId, team.id), isNull(docs.deletedAt), parentId === null ? isNull(docs.parentId) : eq(docs.parentId, parentId), ne(docs.id, d.id)))
      .orderBy(asc(docs.position));
    const i = opts.index === undefined || opts.index < 0 || opts.index > siblings.length ? siblings.length : opts.index;
    const before = siblings[i - 1]?.position;
    const after = siblings[i]?.position;
    const position = before === undefined && after === undefined ? 1000 : before === undefined ? after! - 1000 : after === undefined ? before + 1000 : (before + after) / 2;
    const [updated] = await tx
      .update(docs)
      .set({ parentId, slug, position, version: d.version + 1, updatedAt: new Date(), updatedByKind: actor.kind, updatedById: actor.id })
      .where(eq(docs.id, d.id))
      .returning();
    await emit(tx, actor, team.id, {
      type: "doc.moved",
      entity: "doc",
      entityId: updated.id,
      summary: `moved doc "${updated.title}"`,
      data: { slug: updated.slug },
    });
    return updated;
  });
}

/** Soft delete: sets deletedAt (kept 30 days for recovery/purge); history lives in `events`. */
export async function deleteDoc(actor: Actor, teamRef: string, ref: string) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  await assertDocsWritable(actor, db);
  return db.transaction(async (tx) => {
    const d = await resolveDoc(tx, team.id, ref);
    await tx.update(docs).set({ deletedAt: new Date() }).where(eq(docs.id, d.id));
    // Soft-delete descendants too, so a deleted branch doesn't linger half-visible.
    const toDelete = [d.id];
    for (let i = 0; i < toDelete.length; i++) {
      const kids = await tx.select({ id: docs.id }).from(docs).where(and(eq(docs.parentId, toDelete[i]), isNull(docs.deletedAt)));
      for (const k of kids) toDelete.push(k.id);
    }
    if (toDelete.length > 1) await tx.update(docs).set({ deletedAt: new Date() }).where(inArray(docs.id, toDelete.slice(1)));
    await emit(tx, actor, team.id, {
      type: "doc.deleted",
      entity: "doc",
      entityId: d.id,
      summary: `deleted doc "${d.title}"${toDelete.length > 1 ? ` (and ${toDelete.length - 1} nested)` : ""}`,
      data: { slug: d.slug, title: d.title },
    });
    return { ok: true };
  });
}

export async function linkDocNode(actor: Actor, teamRef: string, docRef: string, nodeRef: string, unlink = false) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef, "edit");
  await assertDocsWritable(actor, db);
  const d = await resolveDoc(db, team.id, docRef);
  const n = await resolveNode(db, team.id, nodeRef);
  if (unlink) {
    await db.delete(docNodes).where(and(eq(docNodes.docId, d.id), eq(docNodes.nodeId, n.id)));
  } else {
    await db.insert(docNodes).values({ docId: d.id, nodeId: n.id }).onConflictDoNothing();
  }
  return { ok: true };
}

/**
 * Full-text search over doc title + body, ranked by ts_rank, with snippets.
 * Computed at query time (to_tsvector('english', …)) rather than a persisted
 * generated column: kept simple and portable between the embedded PGlite used
 * in local dev/tests and real Postgres in prod (ADR: see final report).
 * `max_tokens` is approximated from characters (~4 chars/token, same rule of
 * thumb the briefing budget uses) so results fit an agent's context budget.
 */
export async function searchDocs(actor: Actor, teamRef: string, query: string, opts: { maxTokens?: number } = {}) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef);
  const q = query.trim();
  if (!q) throw new ServiceError("invalid", "query is required");
  const maxChars = Math.min(Math.max((opts.maxTokens ?? 800) * 4, 400), 80_000);

  const tsq = sql`websearch_to_tsquery('english', ${q})`;
  const vector = sql`setweight(to_tsvector('english', ${docs.title}), 'A') || setweight(to_tsvector('english', ${docs.body}), 'B')`;
  const rows = await db
    .select({
      id: docs.id,
      slug: docs.slug,
      title: docs.title,
      body: docs.body,
      updatedAt: docs.updatedAt,
      rank: sql<number>`ts_rank(${vector}, ${tsq})`,
      snippet: sql<string>`ts_headline('english', ${docs.body}, ${tsq}, 'MaxFragments=2, MinWords=5, MaxWords=25')`,
    })
    .from(docs)
    .where(and(eq(docs.teamId, team.id), isNull(docs.deletedAt), sql`${vector} @@ ${tsq}`))
    .orderBy(desc(sql`ts_rank(${vector}, ${tsq})`))
    .limit(50);

  const out: { slug: string; title: string; snippet: string; updatedAt: Date; rank: number }[] = [];
  let used = 0;
  for (const r of rows) {
    const snippet = r.snippet || clipText(r.body, 240);
    const cost = r.title.length + snippet.length + 20;
    if (used + cost > maxChars && out.length) break;
    out.push({ slug: r.slug, title: r.title, snippet, updatedAt: r.updatedAt, rank: r.rank });
    used += cost;
    if (used > maxChars) break;
  }
  return { query: q, results: out, truncated: out.length < rows.length };
}

export function clipText(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** Short index for the briefing: titles + slugs only, never bodies (protects the token budget). */
export async function listDocsIndex(actor: Actor, teamRef: string) {
  const db = await getDb();
  const team = await requireTeam(actor, teamRef);
  return db
    .select({ slug: docs.slug, title: docs.title, parentId: docs.parentId })
    .from(docs)
    .where(and(eq(docs.teamId, team.id), isNull(docs.deletedAt)))
    .orderBy(asc(docs.position));
}
