import { Inject, Injectable } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { pruneSessions } from "../../lib/service-queue";
import { Database } from "../../platform/database/database";
import { EventsService } from "../../platform/events/events.service";
import { RepositoriesService } from "../github/index";
import { TeamAccessService } from "../teams/index";
import { ACTIVE_SESSION_MS, anchoredBy, bestMatches, normPath, type NodeInput } from "./map.rules";
import { SESSION_SYNCED, type SessionSynced } from "./map.events";
import { MapRepository, type NodeRow, type SessionRow } from "./map.repository";

const EXPLAINER_KEYS = ["summary", "purpose", "responsibilities", "interfaces", "gotchas", "details", "columns", "indexes", "anchors", "status"] as const;

export type Session = SessionRow;

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

/**
 * Deterministic sync between working copies and Wheelhouse. Clients (the wheelhouse CLI, driven by Claude Code hooks and git hooks)
 * report facts: which files a session touched and their content hashes. This service turns them into "in flux" nodes (anchored files
 * changed in an active session, not landed), drafts (map updates written against unlanded code, published on landing by the
 * freshness service; the docs module keeps the doc drafts) and session debt (what a session still owes: an issue update, map
 * updates). Board state is never deferred; only map explanations wait for landed code.
 */
@Injectable()
export class SessionsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(MapRepository) private readonly repo: MapRepository,
    @Inject(TeamAccessService) private readonly access: TeamAccessService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(RepositoriesService) private readonly repositories: RepositoriesService,
    @Inject(EventEmitter2) private readonly emitter: EventEmitter2,
  ) {}

  // ───────── sessions ─────────

  /** Record what a session touched. Cheap; called by async PostToolUse hooks and at Stop. */
  async sessionSync(actor: Actor, teamRef: string, r: SessionReport) {
    if (!r.session?.trim()) throw new ServiceError("invalid", "session id is required");
    const team = await this.access.require(actor, teamRef);
    const existing = await this.repo.findSession(r.session);
    if (existing && existing.teamId !== team.id) throw new ServiceError("invalid", "session belongs to another team");
    const repo = r.repository ? await this.repositories.findOrCreateRepository(actor, team.id, r.repository) : null;

    const reported: Record<string, string | null> = Array.isArray(r.files)
      ? Object.fromEntries(r.files.map((f) => [normPath(f), null]))
      : Object.fromEntries(Object.entries(r.files ?? {}).map(([f, h]) => [normPath(f), h]));
    const paths = Object.keys(reported).filter(Boolean);
    // A file whose hash equals what's landed on the default branch isn't a change (never edited, or reverted).
    const landed = paths.length ? await this.repo.landedFilesAt(team.id, paths) : [];
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
      teamId: team.id,
      workspaceId: team.workspaceId,
      apiKeyId: actor.kind === "agent" ? actor.id : null,
      actorName: actor.name,
      client: r.client ?? existing?.client ?? "unknown",
      branch: r.branch ?? existing?.branch ?? null,
      files,
      firstChangeAt: hasChanges ? (existing?.firstChangeAt ?? new Date()) : null,
      lastSeenAt: new Date(),
      endedAt: null,
    };
    if (existing) await this.repo.updateSession(r.session, values);
    else await this.repo.insertSession({ id: r.session, ...values });

    // Drafts whose code this session no longer has in flux were abandoned (e.g. reverted).
    const drafts = await this.repo.pendingNodeDraftsOfSession(r.session);
    if (drafts.length) {
      const ns = await this.repo.nodesOf(team.id);
      const touched = Object.keys(files);
      for (const d of drafts) {
        const n = ns.find((x) => x.id === d.nodeId);
        if (!n || !anchoredBy(n, touched, repo?.slug).length) await this.repo.updateNodeDraft(d.id, { status: "discarded", updatedAt: new Date() });
      }
    }
    // Same for doc drafts (WH-64): the docs module discards the ones this session no longer has in flux.
    await this.emitter.emitAsync(SESSION_SYNCED, { teamId: team.id, sessionId: r.session, touched: Object.keys(files), repository: repo?.slug } satisfies SessionSynced);
    return { ok: true, inFlux: Object.keys(files).length };
  }

  async sessionEnd(actor: Actor, teamRef: string, sessionId: string) {
    const team = await this.access.require(actor, teamRef);
    await this.repo.endSession(team.id, sessionId);
    await pruneSessions(this.db.q, team.id);
    return { ok: true };
  }

  /** Called when an agent works an issue: binds the issue to its most recent active session. */
  async noteIssueActivity(actor: Actor, teamId: string, issueId: string) {
    if (actor.kind !== "agent") return;
    const [s] = await this.repo.activeSessions(teamId, ACTIVE_SESSION_MS, actor.id);
    if (!s) return;
    await this.repo.updateSession(s.id, { issueId, lastSeenAt: new Date() });
  }

  /** The team's sessions that are open and recently seen, all of them or just one key's. */
  async sessionsForTeam(teamId: string, keyId?: string) {
    return this.repo.activeSessions(teamId, ACTIVE_SESSION_MS, keyId);
  }

  // ───────── node drafts ─────────

  /** If this agent has an active session changing the node's anchored files, return it. */
  private async fluxSessionFor(actor: Actor, node: NodeRow) {
    if (actor.kind !== "agent" || !node.anchors.length) return null;
    const sessions = await this.repo.activeSessions(node.teamId, ACTIVE_SESSION_MS, actor.id);
    return sessions.find((s) => anchoredBy(node, Object.keys(s.files)).length) ?? null;
  }

  /**
   * Called by upsertNode for agent edits to existing nodes. When the agent's own session has the node's code in flux, the update is
   * stored as a draft and published when that code lands, so the shared map never describes code that hasn't merged.
   */
  async maybeDraft(actor: Actor, node: NodeRow, input: NodeInput) {
    const patch: Record<string, unknown> = {};
    for (const k of EXPLAINER_KEYS) if (input[k] !== undefined) patch[k] = input[k];
    const confirm = !!input.markFresh && !Object.keys(patch).length;
    if (!Object.keys(patch).length && !confirm) return null;
    const session = await this.fluxSessionFor(actor, node);
    if (!session) return null;
    const d = await this.repo.pendingNodeDraft(node.id, session.id);
    if (d) {
      await this.repo.updateNodeDraft(d.id, { patch: { ...d.patch, ...patch }, confirm: d.confirm && confirm, updatedAt: new Date() });
    } else {
      await this.repo.insertNodeDraft({
        teamId: node.teamId,
        workspaceId: node.workspaceId,
        nodeId: node.id,
        sessionId: session.id,
        authorName: actor.name,
        authorKind: actor.kind,
        patch,
        confirm,
      });
    }
    await this.events.emit(actor, node.teamId, {
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

  async listDrafts(actor: Actor, teamRef: string) {
    const team = await this.access.require(actor, teamRef);
    return this.repo.pendingNodeDraftsOf(team.id);
  }

  // ───────── debt ─────────

  /**
   * What a session still owes before it should end a turn: an issue that reflects the work, and map updates (drafts, edits or
   * confirmations) for the nodes whose files it changed. `clean` means nothing is owed.
   */
  async sessionStatus(actor: Actor, teamRef: string, sessionId: string) {
    const team = await this.access.require(actor, teamRef);
    const s = await this.repo.findSession(sessionId, team.id);
    // Only the agent's own changes create debt; external (human) edits are just in flux.
    const touched = s ? Object.entries(s.files).filter(([, f]) => !f.external).map(([p]) => p) : [];
    if (!s || !touched.length) return { clean: true, files: [], issue: null, nodes: [], unmapped: [], message: "" };

    const since = s.firstChangeAt ?? s.startedAt;
    const keyId = s.apiKeyId;

    // Issue: the one bound to this session, else the latest issue this key worked on since the session started.
    let issue = s.issueId ? await this.repo.issueById(s.issueId) : undefined;
    if (!issue && keyId) {
      const e = await this.repo.latestIssueEventBy(team.id, keyId, s.startedAt);
      if (e) issue = await this.repo.issueById(e.entityId);
      if (issue) await this.repo.updateSession(s.id, { issueId: issue.id });
    }
    const ref = issue ? `${team.key}-${issue.number}` : null;
    const issueOk = issue && keyId ? await this.repo.issueUpdatedBy(issue.id, keyId, since) : false;

    // Map: affected nodes must have a draft/confirmation from this session, or an edit by this key since the change.
    const ns = await this.repo.nodesOf(team.id);
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
    const drafted = new Set(await this.repo.draftedNodeIds(ids, s.id));
    const edited = new Set(keyId ? await this.repo.entityIdsEditedBy(ids, keyId, since) : []);
    const owed = [...affected.values()].filter((a) => !drafted.has(a.node.id) && !edited.has(a.node.id)).map((a) => ({ name: a.node.name, layer: a.node.layer, files: a.files }));

    const lines: string[] = [];
    if (!issue) lines.push(`- No issue is tracking this work. Claim or create an issue in ${team.key} and move it to In Progress (claim_issue / create_issue + move_issue).`);
    else if (!issueOk) lines.push(`- ${ref} hasn't been updated since you started changing files. Comment what you changed, and move it to Review if the work is done.`);
    for (const o of owed)
      lines.push(
        `- Map node ${o.layer}:${o.name} covers files you changed (${o.files.slice(0, 3).join(", ")}${o.files.length > 3 ? "…" : ""}). Update its explanation with upsert_node${o.layer === "data" ? "/upsert_table" : ""}, or call mark_fresh if it's still accurate.`,
      );
    const clean = !!issue && issueOk && !owed.length;
    return {
      clean,
      files: touched,
      issue: issue ? { ref, title: issue.title, updated: issueOk } : null,
      nodes: owed,
      unmapped,
      message: clean
        ? ""
        : `Wheelhouse: this session changed ${touched.length} file(s) in ${team.key}. Before finishing:\n${lines.join("\n")}\n(Map updates for unlanded code are saved as drafts and publish when the code lands.)`,
    };
  }

  // ───────── read model for the UI / briefing ─────────

  /** Per-node in-flux info: which active sessions are changing its files, and pending drafts. */
  async fluxForTeam(teamId: string, teamKey: string) {
    const [sessions, drafts, ns, keyIssues] = await Promise.all([
      this.repo.activeSessions(teamId, ACTIVE_SESSION_MS),
      this.repo.pendingNodeDraftsOf(teamId),
      this.repo.nodesOf(teamId),
      this.repo.issueNumbers(teamId),
    ]);
    const tnum = new Map(keyIssues.map((t) => [t.id, `${teamKey}-${t.number}`]));
    const out: Record<string, { sessions: { id: string; by: string; issue: string | null; files: string[] }[]; drafts: typeof drafts }> = {};
    for (const s of sessions) {
      const files = Object.keys(s.files);
      if (!files.length) continue;
      const hit = new Set<string>();
      for (const f of files) for (const n of bestMatches(ns, f)) hit.add(n.id);
      for (const id of hit) {
        const n = ns.find((x) => x.id === id)!;
        (out[id] ??= { sessions: [], drafts: [] }).sessions.push({ id: s.id, by: s.actorName, issue: s.issueId ? (tnum.get(s.issueId) ?? null) : null, files: anchoredBy(n, files) });
      }
    }
    for (const d of drafts) (out[d.nodeId] ??= { sessions: [], drafts: [] }).drafts.push(d);
    return out;
  }
}
