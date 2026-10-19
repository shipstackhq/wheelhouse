import { and, asc, desc, eq, gt, gte, inArray, isNull } from "drizzle-orm";
import { getDb, schema } from "../db";
import type { Actor } from "./access";
import {
  anchorScore,
  emit,
  getProject,
  normPath,
  pruneSessions,
  ServiceError,
  updateDoc,
  upsertNode,
  type DocRow,
  type DocUpdateInput,
  type NodeInput,
  type NodeRow,
} from "./service";

/**
 * Deterministic sync between working copies and Wheelhouse.
 *
 * Clients (the wheelhouse CLI, driven by Claude Code hooks and git hooks)
 * report facts: which files a session touched, their content hashes, and what
 * landed on the default branch. The server turns those facts into:
 *   - "in flux" nodes: anchored files changed in an active session, not landed
 *   - drafts: map updates written against unlanded code, published on landing
 *   - drift: landed content differs from what a node was described against
 *   - session debt: what a session still owes (ticket update, map updates)
 * Board state is never deferred; only map explanations wait for landed code.
 */

const { nodes, projectFiles, workSessions, nodeDrafts, docs, docDrafts, events, tickets, projects } = schema;

const ACTIVE_MS = 12 * 3600e3;
const EXPLAINER_KEYS = ["summary", "purpose", "responsibilities", "interfaces", "gotchas", "details", "columns", "indexes", "anchors", "status"] as const;
const DOC_PATCH_KEYS = ["title", "body", "anchors"] as const;

type Session = typeof workSessions.$inferSelect;

/** Most specifically anchored nodes per layer for a file (same rule as report_changes). `fileRepo`: the repo slug this file was reported under, for repo-qualified anchors ("backend:src/**"). */
export function bestMatches(ns: NodeRow[], file: string, fileRepo?: string | null) {
  const best = new Map<string, { score: number; nodes: NodeRow[] }>();
  for (const n of ns) {
    const s = Math.max(0, ...n.anchors.map((a) => anchorScore(a, file, fileRepo)));
    if (!s) continue;
    const b = best.get(n.layer);
    if (!b || s > b.score) best.set(n.layer, { score: s, nodes: [n] });
    else if (s === b.score) b.nodes.push(n);
  }
  return [...best.values()].flatMap((b) => b.nodes);
}

const anchoredBy = (n: { anchors: string[] }, files: string[], fileRepo?: string | null) => files.filter((f) => n.anchors.some((a) => anchorScore(a, f, fileRepo) > 0));

async function projectNodes(projectId: string) {
  const db = await getDb();
  return db.select().from(nodes).where(eq(nodes.projectId, projectId));
}

async function activeSessions(projectId: string, apiKeyId?: string) {
  const db = await getDb();
  return db
    .select()
    .from(workSessions)
    .where(
      and(
        eq(workSessions.projectId, projectId),
        isNull(workSessions.endedAt),
        gte(workSessions.lastSeenAt, new Date(Date.now() - ACTIVE_MS)),
        apiKeyId ? eq(workSessions.apiKeyId, apiKeyId) : undefined,
      ),
    )
    .orderBy(desc(workSessions.lastSeenAt));
}

// ───────── sessions ─────────

export type SessionReport = {
  session: string;
  client?: string;
  branch?: string;
  /** Touched paths. Value = content hash now, null = unknown/deleted. A plain array means hashes unknown. */
  files?: string[] | Record<string, string | null>;
  /** Changes noticed in the working copy that the agent didn't make (shown as in flux, not owed by the agent). */
  external?: boolean;
  /** wheelhouse.json's repository name/slug (WH-68). Omitted = old client: files are tracked unqualified, as before. */
  repository?: string;
};

/** Record what a session touched. Cheap; called by async PostToolUse hooks and at Stop. */
export async function sessionSync(actor: Actor, projectRef: string, r: SessionReport) {
  if (!r.session?.trim()) throw new ServiceError("invalid", "session id is required");
  const db = await getDb();
  const project = await getProject(actor, projectRef);
  const [existing] = await db.select().from(workSessions).where(eq(workSessions.id, r.session));
  if (existing && existing.projectId !== project.id) throw new ServiceError("invalid", "session belongs to another project");
  const repo = r.repository ? await (await import("./service")).findOrCreateRepository(actor, project.id, r.repository) : null;

  const reported: Record<string, string | null> = Array.isArray(r.files)
    ? Object.fromEntries(r.files.map((f) => [normPath(f), null]))
    : Object.fromEntries(Object.entries(r.files ?? {}).map(([f, h]) => [normPath(f), h]));
  const paths = Object.keys(reported).filter(Boolean);
  // A file whose hash equals what's landed on the default branch isn't a change (never edited, or reverted).
  const landed = paths.length
    ? await db.select().from(projectFiles).where(and(eq(projectFiles.projectId, project.id), inArray(projectFiles.path, paths)))
    : [];
  const landedHash = new Map(landed.map((f) => [f.path, f.hash]));

  const files = { ...(existing?.files ?? {}) };
  const now = new Date().toISOString();
  for (const p of paths) {
    const h = reported[p];
    if (h && landedHash.get(p) === h) delete files[p];
    else
      files[p] = {
        hash: h ?? files[p]?.hash ?? null,
        at: now,
        ...(r.external && !files[p] ? { external: true } : files[p]?.external && r.external ? { external: true } : {}),
        ...(repo ? { repositoryId: repo.id } : files[p]?.repositoryId ? { repositoryId: files[p].repositoryId } : {}),
      };
  }
  const hasChanges = Object.keys(files).length > 0;
  const values = {
    projectId: project.id,
    apiKeyId: actor.kind === "agent" ? actor.id : null,
    actorName: actor.name,
    client: r.client ?? existing?.client ?? "unknown",
    branch: r.branch ?? existing?.branch ?? null,
    files,
    firstChangeAt: hasChanges ? (existing?.firstChangeAt ?? new Date()) : null,
    lastSeenAt: new Date(),
    endedAt: null,
  };
  if (existing) await db.update(workSessions).set(values).where(eq(workSessions.id, r.session));
  else await db.insert(workSessions).values({ id: r.session, ...values });

  // Drafts whose code this session no longer has in flux were abandoned (e.g. reverted).
  const drafts = await db.select().from(nodeDrafts).where(and(eq(nodeDrafts.sessionId, r.session), eq(nodeDrafts.status, "pending")));
  if (drafts.length) {
    const ns = await projectNodes(project.id);
    const touched = Object.keys(files);
    for (const d of drafts) {
      const n = ns.find((x) => x.id === d.nodeId);
      if (!n || !anchoredBy(n, touched, repo?.slug).length)
        await db.update(nodeDrafts).set({ status: "discarded", updatedAt: new Date() }).where(eq(nodeDrafts.id, d.id));
    }
  }
  // Same for doc drafts (WH-64).
  const docDraftRows = await db.select().from(docDrafts).where(and(eq(docDrafts.sessionId, r.session), eq(docDrafts.status, "pending")));
  if (docDraftRows.length) {
    const ds = await projectDocs(project.id);
    const touched = Object.keys(files);
    for (const d of docDraftRows) {
      const doc = ds.find((x) => x.id === d.docId);
      if (!doc || !anchoredBy(doc, touched, repo?.slug).length)
        await db.update(docDrafts).set({ status: "discarded", updatedAt: new Date() }).where(eq(docDrafts.id, d.id));
    }
  }
  return { ok: true, inFlux: Object.keys(files).length };
}

export async function sessionEnd(actor: Actor, projectRef: string, sessionId: string) {
  const db = await getDb();
  const project = await getProject(actor, projectRef);
  await db
    .update(workSessions)
    .set({ endedAt: new Date() })
    .where(and(eq(workSessions.id, sessionId), eq(workSessions.projectId, project.id)));
  await pruneSessions(db, project.id);
  return { ok: true };
}

/** Called when an agent works a ticket: binds the ticket to its most recent active session. */
export async function noteTicketActivity(actor: Actor, projectId: string, ticketId: string) {
  if (actor.kind !== "agent") return;
  const [s] = await activeSessions(projectId, actor.id);
  if (!s) return;
  const db = await getDb();
  await db.update(workSessions).set({ ticketId, lastSeenAt: new Date() }).where(eq(workSessions.id, s.id));
}

// ───────── drafts ─────────

/** If this agent has an active session changing the node's anchored files, return it. */
async function fluxSessionFor(actor: Actor, node: NodeRow) {
  if (actor.kind !== "agent" || !node.anchors.length) return null;
  const sessions = await activeSessions(node.projectId, actor.id);
  return sessions.find((s) => anchoredBy(node, Object.keys(s.files)).length) ?? null;
}

/**
 * Called by upsertNode for agent edits to existing nodes. When the agent's own
 * session has the node's code in flux, the update is stored as a draft and
 * published when that code lands, so the shared map never describes code that
 * hasn't merged.
 */
export async function maybeDraft(actor: Actor, node: NodeRow, input: NodeInput) {
  const patch: Record<string, unknown> = {};
  for (const k of EXPLAINER_KEYS) if (input[k] !== undefined) patch[k] = input[k];
  const confirm = !!input.markFresh && !Object.keys(patch).length;
  if (!Object.keys(patch).length && !confirm) return null;
  const session = await fluxSessionFor(actor, node);
  if (!session) return null;
  const db = await getDb();
  const [d] = await db
    .select()
    .from(nodeDrafts)
    .where(and(eq(nodeDrafts.nodeId, node.id), eq(nodeDrafts.sessionId, session.id), eq(nodeDrafts.status, "pending")));
  if (d) {
    await db
      .update(nodeDrafts)
      .set({ patch: { ...d.patch, ...patch }, confirm: d.confirm && confirm, updatedAt: new Date() })
      .where(eq(nodeDrafts.id, d.id));
  } else {
    await db.insert(nodeDrafts).values({
      projectId: node.projectId,
      nodeId: node.id,
      sessionId: session.id,
      authorName: actor.name,
      authorKind: actor.kind,
      patch,
      confirm,
    });
  }
  await emit(db, actor, node.projectId, {
    type: "node.drafted",
    entity: "node",
    entityId: node.id,
    summary: `drafted ${confirm ? "a confirmation of" : "an update to"} ${node.layer} "${node.name}" (publishes when the code lands)`,
    data: { name: node.name, layer: node.layer, fields: Object.keys(patch) },
  });
  return {
    draft: true,
    note: "Saved as a draft: this session's changes to the node's files haven't landed on the default branch yet. It publishes automatically when they do.",
  };
}

export async function listDrafts(actor: Actor, projectRef: string) {
  const db = await getDb();
  const project = await getProject(actor, projectRef);
  return db
    .select()
    .from(nodeDrafts)
    .where(and(eq(nodeDrafts.projectId, project.id), eq(nodeDrafts.status, "pending")))
    .orderBy(asc(nodeDrafts.createdAt));
}

/** Human action: publish or discard a pending draft now. */
export async function resolveDraft(actor: Actor, projectRef: string, draftId: string, action: "publish" | "discard") {
  const db = await getDb();
  const project = await getProject(actor, projectRef, "edit");
  const [d] = await db
    .select()
    .from(nodeDrafts)
    .where(and(eq(nodeDrafts.id, draftId), eq(nodeDrafts.projectId, project.id), eq(nodeDrafts.status, "pending")));
  if (!d) throw new ServiceError("not_found", "Draft not found or already resolved");
  if (action === "publish") await applyDraft(actor, project.id, d);
  await db
    .update(nodeDrafts)
    .set({ status: action === "publish" ? "published" : "discarded", updatedAt: new Date() })
    .where(eq(nodeDrafts.id, d.id));
  return { ok: true };
}

async function applyDraft(actor: Actor, projectId: string, d: typeof nodeDrafts.$inferSelect, hashes?: Record<string, string>) {
  await upsertNode(actor, projectId, { id: d.nodeId, ...(d.patch as NodeInput), markFresh: true, forcePublish: true, describedHashes: hashes });
}

// ───────── doc drafts (WH-64) ─────────
// Mirrors the node draft flow exactly: an agent session editing a doc whose anchored
// files are in flux (changed in that session, not yet landed) gets the edit stored as
// a draft, published when land() processes those files.

async function projectDocs(projectId: string) {
  const db = await getDb();
  return db.select().from(docs).where(and(eq(docs.projectId, projectId), isNull(docs.deletedAt)));
}

/** If this agent has an active session changing the doc's anchored files, return it. */
async function fluxSessionForDoc(actor: Actor, doc: DocRow) {
  if (actor.kind !== "agent" || !doc.anchors.length) return null;
  const sessions = await activeSessions(doc.projectId, actor.id);
  return sessions.find((s) => anchoredBy(doc, Object.keys(s.files)).length) ?? null;
}

/**
 * Called by updateDoc for agent edits to existing docs. When the agent's own session
 * has the doc's anchored code in flux, the update is stored as a draft and published
 * when that code lands, so the shared doc never describes code that hasn't merged.
 */
export async function maybeDraftDoc(actor: Actor, doc: DocRow, input: DocUpdateInput) {
  const patch: Record<string, unknown> = {};
  for (const k of DOC_PATCH_KEYS) if (input[k] !== undefined) patch[k] = input[k];
  const confirm = !!input.markFresh && !Object.keys(patch).length;
  if (!Object.keys(patch).length && !confirm) return null;
  const session = await fluxSessionForDoc(actor, doc);
  if (!session) return null;
  const db = await getDb();
  const [d] = await db
    .select()
    .from(docDrafts)
    .where(and(eq(docDrafts.docId, doc.id), eq(docDrafts.sessionId, session.id), eq(docDrafts.status, "pending")));
  if (d) {
    await db
      .update(docDrafts)
      .set({ patch: { ...d.patch, ...patch }, confirm: d.confirm && confirm, updatedAt: new Date() })
      .where(eq(docDrafts.id, d.id));
  } else {
    await db.insert(docDrafts).values({
      projectId: doc.projectId,
      docId: doc.id,
      sessionId: session.id,
      authorName: actor.name,
      authorKind: actor.kind,
      patch,
      confirm,
    });
  }
  await emit(db, actor, doc.projectId, {
    type: "doc.drafted",
    entity: "doc",
    entityId: doc.id,
    summary: `drafted ${confirm ? "a confirmation of" : "an update to"} doc "${doc.title}" (publishes when the code lands)`,
    data: { title: doc.title, slug: doc.slug, fields: Object.keys(patch) },
  });
  return {
    draft: true,
    note: "Saved as a draft: this session's changes to the doc's anchored files haven't landed on the default branch yet. It publishes automatically when they do.",
  };
}

export async function listDocDrafts(actor: Actor, projectRef: string) {
  const db = await getDb();
  const project = await getProject(actor, projectRef);
  return db
    .select()
    .from(docDrafts)
    .where(and(eq(docDrafts.projectId, project.id), eq(docDrafts.status, "pending")))
    .orderBy(asc(docDrafts.createdAt));
}

/** Human action: publish or discard a pending doc draft now. */
export async function resolveDocDraft(actor: Actor, projectRef: string, draftId: string, action: "publish" | "discard") {
  const db = await getDb();
  const project = await getProject(actor, projectRef, "edit");
  const [d] = await db
    .select()
    .from(docDrafts)
    .where(and(eq(docDrafts.id, draftId), eq(docDrafts.projectId, project.id), eq(docDrafts.status, "pending")));
  if (!d) throw new ServiceError("not_found", "Draft not found or already resolved");
  if (action === "publish") await applyDocDraft(actor, project.id, d);
  await db
    .update(docDrafts)
    .set({ status: action === "publish" ? "published" : "discarded", updatedAt: new Date() })
    .where(eq(docDrafts.id, d.id));
  return { ok: true };
}

async function applyDocDraft(actor: Actor, projectId: string, d: typeof docDrafts.$inferSelect, hashes?: Record<string, string>) {
  await updateDoc(actor, projectId, d.docId, { ...(d.patch as DocUpdateInput), markFresh: true, forcePublish: true, describedHashes: hashes });
}

// ───────── landing ─────────

export type LandReport = {
  sha?: string;
  branch?: string;
  /** Changed paths on the default branch → new content hash (null = deleted). */
  files: Record<string, string | null>;
  /** Initial import: record hashes as the described baseline without flagging anything. */
  baseline?: boolean;
  /** wheelhouse.json's repository name/slug (WH-68). Omitted = old client / no repo info: falls back to the project's unqualified default repo, so single-repo projects keep working unchanged. */
  repository?: string;
};

/**
 * Code landed on the default branch (git hook / CI). Updates the server's view
 * of the branch, publishes drafts for the affected nodes, and flags drift where
 * no draft exists. Reverting a file to its described content clears its drift.
 *
 * Repository qualification (WH-68): a monorepo connected to several projects reports changes to
 * all of them, but each project's `repositories` row carries its own `pathLimit` (a directory such
 * as "packages/billing/"); files outside this project's path limit are ignored here so each project
 * only sees the slice of the monorepo it owns.
 */
export async function land(actor: Actor, projectRef: string, r: LandReport) {
  const db = await getDb();
  const project = await getProject(actor, projectRef, "edit");
  const { findOrCreateRepository } = await import("./service");
  const repo = await findOrCreateRepository(actor, project.id, r.repository);
  const limit = repo?.pathLimit?.trim().replace(/^\/+/, "").replace(/\/*$/, "/") || null;
  const changed = Object.entries(r.files ?? {})
    .map(([p, h]) => [normPath(p), h] as const)
    .filter(([p]) => p && (!limit || p.startsWith(limit)));
  if (!changed.length) return { files: 0, published: [], stale: [], fresh: [], publishedDocs: [], staleDocs: [], freshDocs: [] };

  for (const [path, hash] of changed) {
    if (hash) {
      await db
        .insert(projectFiles)
        .values({ projectId: project.id, path, hash, sha: r.sha ?? null, repositoryId: repo?.id ?? null })
        .onConflictDoUpdate({
          target: [projectFiles.projectId, projectFiles.path],
          set: { hash, sha: r.sha ?? null, repositoryId: repo?.id ?? null, updatedAt: new Date() },
        });
    } else {
      await db.delete(projectFiles).where(and(eq(projectFiles.projectId, project.id), eq(projectFiles.path, path)));
    }
  }

  const ns = await projectNodes(project.id);
  const affected = new Map<string, { node: NodeRow; files: [string, string | null][] }>();
  for (const [path, hash] of changed) {
    for (const n of r.baseline ? ns.filter((x) => anchoredBy(x, [path], repo?.slug).length) : bestMatches(ns, path, repo?.slug)) {
      const a = affected.get(n.id) ?? { node: n, files: [] };
      a.files.push([path, hash]);
      affected.set(n.id, a);
    }
  }

  // Same for docs (WH-64): no per-layer grouping, so any doc anchored to a changed path is affected.
  const ds = await projectDocs(project.id);
  const affectedDocs = new Map<string, { doc: DocRow; files: [string, string | null][] }>();
  for (const [path, hash] of changed) {
    for (const d of ds.filter((x) => anchoredBy(x, [path], repo?.slug).length)) {
      const a = affectedDocs.get(d.id) ?? { doc: d, files: [] };
      a.files.push([path, hash]);
      affectedDocs.set(d.id, a);
    }
  }

  const pending = affected.size
    ? await db
        .select()
        .from(nodeDrafts)
        .where(and(inArray(nodeDrafts.nodeId, [...affected.keys()]), eq(nodeDrafts.status, "pending")))
        .orderBy(asc(nodeDrafts.createdAt))
    : [];
  const pendingDocs = affectedDocs.size
    ? await db
        .select()
        .from(docDrafts)
        .where(and(inArray(docDrafts.docId, [...affectedDocs.keys()]), eq(docDrafts.status, "pending")))
        .orderBy(asc(docDrafts.createdAt))
    : [];

  const published: string[] = [];
  const stale: string[] = [];
  const fresh: string[] = [];
  const publishedDocs: string[] = [];
  const staleDocs: string[] = [];
  const freshDocs: string[] = [];
  const short = r.sha?.slice(0, 8);

  for (const { node, files } of affected.values()) {
    const landedHashes: Record<string, string> = { ...node.describedHashes };
    for (const [p, h] of files) {
      if (h) landedHashes[p] = h;
      else delete landedHashes[p];
    }
    const drafts = pending.filter((d) => d.nodeId === node.id);
    if (drafts.length && !r.baseline) {
      // The work that was in flux has landed: publish what the agent wrote against it.
      for (const d of drafts) {
        await applyDraft(actor, project.id, d, landedHashes);
        await db.update(nodeDrafts).set({ status: "published", updatedAt: new Date() }).where(eq(nodeDrafts.id, d.id));
      }
      published.push(`${node.layer}:${node.name}`);
      continue;
    }

    const neverBaselined = !Object.keys(node.describedHashes).length;
    const drift = new Set(node.driftPaths);
    const described = { ...node.describedHashes };
    for (const [p, h] of files) {
      if (r.baseline || neverBaselined) {
        if (h) described[p] = h;
        continue;
      }
      if (!h) {
        if (p in described) drift.add(p); // a described file was deleted
        continue;
      }
      if (described[p] === h) drift.delete(p);
      else drift.add(p);
    }
    const driftPaths = [...drift];
    const wasDrift = node.stale && node.staleSource === "drift";
    const nowStale = driftPaths.length > 0;
    const set: Partial<typeof nodes.$inferInsert> = { describedHashes: described, driftPaths };
    if (nowStale && !(node.stale && node.staleSource === "report")) {
      Object.assign(set, {
        stale: true,
        staleSource: "drift",
        staleReason: `${driftPaths.slice(0, 3).join(", ")}${driftPaths.length > 3 ? ` +${driftPaths.length - 3} more` : ""} changed${short ? ` in ${short}` : ""} since it was described`,
      });
      if (!node.stale) stale.push(`${node.layer}:${node.name}`);
    } else if (!nowStale && wasDrift) {
      Object.assign(set, { stale: false, staleSource: null, staleReason: null });
      fresh.push(`${node.layer}:${node.name}`);
    }
    await db.update(nodes).set(set).where(eq(nodes.id, node.id));
  }

  for (const { doc, files } of affectedDocs.values()) {
    const landedHashes: Record<string, string> = { ...doc.describedHashes };
    for (const [p, h] of files) {
      if (h) landedHashes[p] = h;
      else delete landedHashes[p];
    }
    const drafts = pendingDocs.filter((d) => d.docId === doc.id);
    if (drafts.length && !r.baseline) {
      // The work that was in flux has landed: publish what the agent wrote against it.
      for (const d of drafts) {
        await applyDocDraft(actor, project.id, d, landedHashes);
        await db.update(docDrafts).set({ status: "published", updatedAt: new Date() }).where(eq(docDrafts.id, d.id));
      }
      publishedDocs.push(doc.slug);
      continue;
    }

    const neverBaselined = !Object.keys(doc.describedHashes).length;
    const drift = new Set(doc.driftPaths);
    const described = { ...doc.describedHashes };
    for (const [p, h] of files) {
      if (r.baseline || neverBaselined) {
        if (h) described[p] = h;
        continue;
      }
      if (!h) {
        if (p in described) drift.add(p); // a described file was deleted
        continue;
      }
      if (described[p] === h) drift.delete(p);
      else drift.add(p);
    }
    const driftPaths = [...drift];
    const wasDrift = doc.stale && doc.staleSource === "drift";
    const nowStale = driftPaths.length > 0;
    const set: Partial<typeof docs.$inferInsert> = { describedHashes: described, driftPaths };
    if (nowStale && !(doc.stale && doc.staleSource === "report")) {
      Object.assign(set, {
        stale: true,
        staleSource: "drift",
        staleReason: `${driftPaths.slice(0, 3).join(", ")}${driftPaths.length > 3 ? ` +${driftPaths.length - 3} more` : ""} changed${short ? ` in ${short}` : ""} since it was described`,
      });
      if (!doc.stale) staleDocs.push(doc.slug);
    } else if (!nowStale && wasDrift) {
      Object.assign(set, { stale: false, staleSource: null, staleReason: null });
      freshDocs.push(doc.slug);
    }
    await db.update(docs).set(set).where(eq(docs.id, doc.id));
  }

  // Sessions whose in-flux files just landed (same content, or unknown) are no longer in flux for them.
  const landedMap = new Map(changed);
  for (const s of await activeSessions(project.id)) {
    let dirty = false;
    const files = { ...s.files };
    for (const [p, f] of Object.entries(files)) {
      if (!landedMap.has(p)) continue;
      if (f.hash === null || f.hash === landedMap.get(p)) {
        delete files[p];
        dirty = true;
      }
    }
    if (dirty) {
      await db
        .update(workSessions)
        .set({ files, firstChangeAt: Object.keys(files).length ? s.firstChangeAt : null })
        .where(eq(workSessions.id, s.id));
    }
  }

  if (!r.baseline) {
    await emit(db, actor, project.id, {
      type: "code.landed",
      entity: "project",
      entityId: project.id,
      summary: `landed ${changed.length} file(s)${short ? ` (${short})` : ""}${published.length ? `; published ${published.length} map draft(s)` : ""}${stale.length ? `; ${stale.length} node(s) drifted` : ""}${fresh.length ? `; ${fresh.length} back in sync` : ""}${publishedDocs.length ? `; published ${publishedDocs.length} doc draft(s)` : ""}${staleDocs.length ? `; ${staleDocs.length} doc(s) drifted` : ""}${freshDocs.length ? `; ${freshDocs.length} doc(s) back in sync` : ""}`,
      data: { sha: r.sha, branch: r.branch, published, stale, fresh, publishedDocs, staleDocs, freshDocs },
    });
  }
  return { files: changed.length, published, stale, fresh, publishedDocs, staleDocs, freshDocs };
}

// ───────── debt ─────────

/**
 * What a session still owes before it should end a turn: a ticket that reflects
 * the work, and map updates (drafts, edits or confirmations) for the nodes whose
 * files it changed. `clean` means nothing is owed.
 */
export async function sessionStatus(actor: Actor, projectRef: string, sessionId: string) {
  const db = await getDb();
  const project = await getProject(actor, projectRef);
  const [s] = await db.select().from(workSessions).where(and(eq(workSessions.id, sessionId), eq(workSessions.projectId, project.id)));
  // Only the agent's own changes create debt; external (human) edits are just in flux.
  const touched = s ? Object.entries(s.files).filter(([, f]) => !f.external).map(([p]) => p) : [];
  if (!s || !touched.length) return { clean: true, files: [], ticket: null, nodes: [], unmapped: [], message: "" };

  const since = s.firstChangeAt ?? s.startedAt;
  const keyId = s.apiKeyId;

  // Ticket: the one bound to this session, else the latest ticket this key worked on since the session started.
  let ticket = s.ticketId ? (await db.select().from(tickets).where(eq(tickets.id, s.ticketId)))[0] : undefined;
  if (!ticket && keyId) {
    const [e] = await db
      .select()
      .from(events)
      .where(and(eq(events.projectId, project.id), eq(events.actorId, keyId), eq(events.entity, "ticket"), gte(events.createdAt, s.startedAt)))
      .orderBy(desc(events.seq))
      .limit(1);
    if (e) ticket = (await db.select().from(tickets).where(eq(tickets.id, e.entityId)))[0];
    if (ticket) await db.update(workSessions).set({ ticketId: ticket.id }).where(eq(workSessions.id, s.id));
  }
  const [proj] = await db.select().from(projects).where(eq(projects.id, project.id));
  const ref = ticket ? `${proj.key}-${ticket.number}` : null;
  let ticketOk = false;
  if (ticket && keyId) {
    const [upd] = await db
      .select({ seq: events.seq })
      .from(events)
      .where(
        and(
          eq(events.entityId, ticket.id),
          eq(events.actorId, keyId),
          inArray(events.type, ["comment.created", "ticket.moved", "ticket.updated"]),
          gt(events.createdAt, since),
        ),
      )
      .limit(1);
    ticketOk = !!upd;
  }

  // Map: affected nodes must have a draft/confirmation from this session, or an edit by this key since the change.
  const ns = await projectNodes(project.id);
  const affected = new Map<string, { node: NodeRow; files: string[] }>();
  const unmapped: string[] = [];
  for (const f of touched) {
    const m = bestMatches(ns, f);
    if (!m.length) unmapped.push(f);
    for (const n of m) {
      const a = affected.get(n.id) ?? { node: n, files: [] };
      a.files.push(f);
      affected.set(n.id, a);
    }
  }
  const ids = [...affected.keys()];
  const drafted = new Set(
    ids.length
      ? (
          await db
            .select({ nodeId: nodeDrafts.nodeId })
            .from(nodeDrafts)
            .where(and(inArray(nodeDrafts.nodeId, ids), eq(nodeDrafts.sessionId, s.id), eq(nodeDrafts.status, "pending")))
        ).map((d) => d.nodeId)
      : [],
  );
  const edited = new Set(
    ids.length && keyId
      ? (
          await db
            .select({ id: events.entityId })
            .from(events)
            .where(and(inArray(events.entityId, ids), eq(events.actorId, keyId), gt(events.createdAt, since)))
        ).map((e) => e.id)
      : [],
  );
  const owed = [...affected.values()]
    .filter((a) => !drafted.has(a.node.id) && !edited.has(a.node.id))
    .map((a) => ({ name: a.node.name, layer: a.node.layer, files: a.files }));

  const lines: string[] = [];
  if (!ticket) lines.push(`- No ticket is tracking this work. Claim or create a ticket in ${proj.key} and move it to In Progress (claim_ticket / create_ticket + move_ticket).`);
  else if (!ticketOk) lines.push(`- ${ref} hasn't been updated since you started changing files. Comment what you changed, and move it to Review if the work is done.`);
  for (const o of owed)
    lines.push(
      `- Map node ${o.layer}:${o.name} covers files you changed (${o.files.slice(0, 3).join(", ")}${o.files.length > 3 ? "…" : ""}). Update its explanation with upsert_node${o.layer === "data" ? "/upsert_table" : ""}, or call mark_fresh if it's still accurate.`,
    );
  const clean = !!ticket && ticketOk && !owed.length;
  return {
    clean,
    files: touched,
    ticket: ticket ? { ref, title: ticket.title, updated: ticketOk } : null,
    nodes: owed,
    unmapped,
    message: clean
      ? ""
      : `Wheelhouse: this session changed ${touched.length} file(s) in ${proj.key}. Before finishing:\n${lines.join("\n")}\n(Map updates for unlanded code are saved as drafts and publish when the code lands.)`,
  };
}

// ───────── read models for the UI / briefing ─────────

/** Per-node in-flux info: which active sessions are changing its files, and pending drafts. */
export async function fluxForProject(projectId: string) {
  const db = await getDb();
  const [sessions, drafts, ns, keyTickets] = await Promise.all([
    activeSessions(projectId),
    db.select().from(nodeDrafts).where(and(eq(nodeDrafts.projectId, projectId), eq(nodeDrafts.status, "pending"))),
    projectNodes(projectId),
    db.select({ id: tickets.id, number: tickets.number }).from(tickets).where(eq(tickets.projectId, projectId)),
  ]);
  const [proj] = await db.select({ key: projects.key }).from(projects).where(eq(projects.id, projectId));
  const tnum = new Map(keyTickets.map((t) => [t.id, `${proj?.key}-${t.number}`]));
  const out: Record<string, { sessions: { id: string; by: string; ticket: string | null; files: string[] }[]; drafts: typeof drafts }> = {};
  for (const s of sessions) {
    const files = Object.keys(s.files);
    if (!files.length) continue;
    const hit = new Set<string>();
    for (const f of files) for (const n of bestMatches(ns, f)) hit.add(n.id);
    for (const id of hit) {
      const n = ns.find((x) => x.id === id)!;
      (out[id] ??= { sessions: [], drafts: [] }).sessions.push({ id: s.id, by: s.actorName, ticket: s.ticketId ? (tnum.get(s.ticketId) ?? null) : null, files: anchoredBy(n, files) });
    }
  }
  for (const d of drafts) (out[d.nodeId] ??= { sessions: [], drafts: [] }).drafts.push(d);
  return out;
}

export async function sessionsForProject(projectId: string) {
  return activeSessions(projectId);
}

export type { Session };
