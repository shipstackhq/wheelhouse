import { Inject, Injectable } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import type { Actor } from "../../common/actor";
import { ServiceError } from "../../common/service-error";
import { EventsService } from "../../platform/events/events.service";
import { GithubApiError, isZeroSha, type ChangedFile, type GithubApi } from "./api";
import { githubConfig } from "./config";
import { ISSUE_COMMENT_REQUESTED, ISSUE_MOVE_REQUESTED, PUSH_LANDED, type IssueCommentRequested, type IssueMoveRequested, type PushLanded } from "./github.events";
import { GithubRepository } from "./github.repository";
import { ciState, decideMove, type CheckState } from "./pr-rules";
import { parseIssueRefs, refsForTeam } from "./refs";
import { github } from "./runtime";
import { verifySignature } from "./signature";

/** Writes made because of something GitHub reported are attributed to this actor, like the claim sweep's "Wheelhouse". */
export const GITHUB_ACTOR_ID = "00000000-0000-0000-0000-000000000000";
/** It reaches only the team that owns the repository the delivery is about (WH-120). */
export const githubActor = (workspaceId: string, teamId: string): Actor => ({ kind: "human", id: GITHUB_ACTOR_ID, name: "GitHub", workspaceId, system: true, teamId });

/** Land at most this many files per call, like the baseline does. */
const LAND_CHUNK = 2000;

export const MAX_WEBHOOK_BODY = 5 * 1024 * 1024; // GitHub's own limit is 25 MB; nothing we use comes close to this

/** What a host sends back. `json` is sent as JSON, `text` as plain text. */
export type WebhookReply = { status: number; text?: string; json?: unknown };

export type Delivery = { event: string; deliveryId: string; payload: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
export type Outcome = { status: "handled" | "ignored" | "duplicate"; detail?: string; matched?: number };

/**
 * What GitHub tells us (WH-20): the webhook, and what each delivery does (push lands files on the map, pull requests and check runs
 * move and comment on the issues they name). The signature is checked against the raw body before anything is parsed or looked up, and
 * a failure is one plain 401. What a delivery may touch is decided in `targetsFor`: only repositories that a workspace's own, verified
 * installation has connected.
 */
@Injectable()
export class DeliveriesService {
  constructor(
    @Inject(GithubRepository) private readonly repo: GithubRepository,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(EventEmitter2) private readonly emitter: EventEmitter2,
  ) {}

  /** The host reads the body (`readBody`) so the bytes are exactly what GitHub signed. */
  async receiveWebhook(i: {
    declaredLength: number;
    readBody: () => Promise<string>;
    signature: string | null;
    event: string | null;
    deliveryId: string | null;
  }): Promise<WebhookReply> {
    const cfg = githubConfig();
    if (!cfg) return { status: 503, text: "The GitHub App is not configured on this server" };

    if (i.declaredLength > MAX_WEBHOOK_BODY) return { status: 413, text: "Too large" };
    const raw = await i.readBody();
    if (raw.length > MAX_WEBHOOK_BODY) return { status: 413, text: "Too large" };

    if (!verifySignature(cfg.webhookSecret, raw, i.signature)) return { status: 401, text: "Bad signature" };

    if (!i.event || !i.deliveryId) return { status: 400, text: "Missing GitHub headers" };
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw);
    } catch {
      return { status: 400, text: "Not JSON" };
    }

    try {
      return { status: 200, json: await this.handleDelivery({ event: i.event, deliveryId: i.deliveryId, payload }, github()?.api ?? null) };
    } catch (e) {
      console.error(`[github] ${i.event} ${i.deliveryId} failed:`, e instanceof Error ? e.message : e);
      return { status: 500, text: "Could not process this delivery; it can be redelivered" };
    }
  }

  /** The repositories a webhook is about: this exact installation and repository id, the installation registered to the team's own workspace. */
  targetsFor(installationId: string, repoId: string) {
    return this.repo.targetsFor(installationId, repoId);
  }

  async handleDelivery(d: Delivery, api: GithubApi | null): Promise<Outcome> {
    if (!(await this.repo.claimDelivery(d.deliveryId, d.event))) return { status: "duplicate" };
    try {
      return await this.dispatch(d, api);
    } catch (e) {
      await this.repo.releaseDelivery(d.deliveryId); // let GitHub's redelivery try again
      throw e;
    }
  }

  private async dispatch(d: Delivery, api: GithubApi | null): Promise<Outcome> {
    const installationId = d.payload.installation?.id != null ? String(d.payload.installation.id) : null;
    switch (d.event) {
      case "ping":
        return { status: "handled", detail: "pong" };
      case "installation":
        return this.onInstallation(d.payload, installationId);
      case "push":
        return this.onPush(d.payload, installationId, api);
      case "pull_request":
        return this.onPullRequest(d.payload, installationId);
      case "check_run":
        return this.onCheckRun(d.payload, installationId);
      default:
        return { status: "ignored", detail: `event "${d.event}" is not used` };
    }
  }

  private async onInstallation(payload: Delivery["payload"], installationId: string | null): Promise<Outcome> {
    if (!installationId) return { status: "ignored" };
    if (payload.action === "deleted") {
      await this.repo.deleteInstallation(installationId);
      return { status: "handled", detail: "installation removed" };
    }
    return { status: "ignored", detail: `installation ${payload.action}` };
  }

  private async onPush(payload: Delivery["payload"], installationId: string | null, api: GithubApi | null): Promise<Outcome> {
    const repoId = payload.repository?.id != null ? String(payload.repository.id) : null;
    if (!installationId || !repoId) return { status: "ignored", detail: "no installation or repository" };
    if (payload.deleted || typeof payload.ref !== "string" || !payload.ref.startsWith("refs/heads/")) return { status: "ignored", detail: "not a branch update" };
    const branch = payload.ref.slice("refs/heads/".length);
    const targets = (await this.targetsFor(installationId, repoId)).filter((t) => t.repo.defaultBranch === branch);
    if (!targets.length) return { status: "ignored", detail: "not a connected repository's default branch" };
    if (!api) throw new ServiceError("invalid", "GitHub App is not configured on this server");

    const after = String(payload.after);
    const before = payload.before ? String(payload.before) : null;
    // Ask GitHub once, however many teams share the repository.
    let files: ChangedFile[];
    try {
      if (isZeroSha(before)) files = (await api.treeAt(installationId, repoId, after)).files;
      else files = await api.changedBetween(installationId, repoId, before!, after);
    } catch (e) {
      // The old commit is gone (a force push): fall back to everything at the new one; the hash comparison sorts out what really changed.
      if (e instanceof GithubApiError && (e.status === 404 || e.status === 422) && !isZeroSha(before)) files = (await api.treeAt(installationId, repoId, after)).files;
      else throw e;
    }

    for (const t of targets) {
      const actor = githubActor(t.team.workspaceId, t.team.id);
      for (let i = 0; i < files.length || i === 0; i += LAND_CHUNK) {
        const chunk = Object.fromEntries(files.slice(i, i + LAND_CHUNK).map((f) => [f.path, f.hash]));
        if (!Object.keys(chunk).length) break;
        await this.emitter.emitAsync(PUSH_LANDED, { actor, teamKey: t.team.key, sha: after, branch, files: chunk, repository: t.repo.slug } satisfies PushLanded); // the map module lands them
      }
      await this.repo.touchRepository(t.repo.id);
    }
    return { status: "handled", matched: targets.length, detail: `${files.length} file(s)` };
  }

  private async issuesByRefs(teamId: string, teamKey: string, refs: { key: string; number: number }[]) {
    const wanted = refsForTeam(refs, teamKey);
    if (!wanted.length) return [];
    const rows = await this.repo.issuesByNumbers(teamId, wanted.map((w) => w.number));
    return rows.map((r) => ({ ...r.t, status: r.status, ref: `${teamKey}-${r.t.number}` }));
  }

  private async onPullRequest(payload: Delivery["payload"], installationId: string | null): Promise<Outcome> {
    const repoId = payload.repository?.id != null ? String(payload.repository.id) : null;
    const pr = payload.pull_request;
    if (!installationId || !repoId || !pr) return { status: "ignored" };
    const targets = await this.targetsFor(installationId, repoId);
    if (!targets.length) return { status: "ignored", detail: "not a connected repository" };

    const action: string = payload.action;
    const merged = !!pr.merged;
    const state = merged ? "merged" : pr.state === "closed" ? "closed" : "open";
    const headSha = String(pr.head?.sha ?? "");
    const headBranch = String(pr.head?.ref ?? "");

    for (const t of targets) {
      const existing = await this.repo.pullRequest(t.repo.id, pr.number);
      const newCommit = !!existing && existing.headSha !== headSha;
      const row = await this.repo.upsertPullRequest(
        { repositoryId: t.repo.id, number: pr.number, title: String(pr.title ?? ""), url: String(pr.html_url ?? ""), author: String(pr.user?.login ?? ""), headBranch, headSha, state, draft: !!pr.draft },
        {
          title: String(pr.title ?? ""),
          url: String(pr.html_url ?? ""),
          headBranch,
          headSha,
          state,
          draft: !!pr.draft,
          // A new commit starts a new round of checks.
          ...(newCommit ? { checks: {}, ciState: null } : {}),
          updatedAt: new Date(),
        },
      );

      const refs = parseIssueRefs(pr.title, headBranch);
      const linked = await this.issuesByRefs(t.team.id, t.team.key, refs);
      await this.repo.replaceLinks(row.id, linked.map((x) => x.id));
      await this.repo.touchRepository(t.repo.id);

      const actor = githubActor(t.team.workspaceId, t.team.id);
      const boardStatuses = await this.repo.boardStatuses(t.team.id);
      for (const tk of linked) {
        if (["opened", "reopened", "closed", "ready_for_review"].includes(action)) {
          await this.events.emit(actor, t.team.id, {
            type: "issue.pull_request",
            entity: "issue",
            entityId: tk.id,
            summary: `pull request #${pr.number} ${merged ? "merged" : action === "closed" ? "closed" : action === "ready_for_review" ? "is ready for review" : action} for ${tk.ref}: ${pr.title}`,
            data: { ref: tk.ref, number: pr.number, url: pr.html_url, state },
          });
        }
        const last = await this.repo.lastMove(tk.id);
        const current = boardStatuses.find((c) => c.id === tk.statusId);
        if (!current) continue;
        const decision = decideMove({
          action,
          merged,
          draft: !!pr.draft,
          status: current,
          statuses: boardStatuses,
          lastMove: last && last.actorId !== GITHUB_ACTOR_ID ? { at: last.at, by: last.by } : null,
          now: new Date(),
        });
        if (decision.move) await this.emitter.emitAsync(ISSUE_MOVE_REQUESTED, { actor, ref: tk.ref, status: decision.move } satisfies IssueMoveRequested); // the issues module moves it
        if (decision.note) await this.emitter.emitAsync(ISSUE_COMMENT_REQUESTED, { actor, ref: tk.ref, body: `Pull request [#${pr.number}](${pr.html_url}) ${decision.note}` } satisfies IssueCommentRequested);
      }
    }
    return { status: "handled", matched: targets.length };
  }

  private async onCheckRun(payload: Delivery["payload"], installationId: string | null): Promise<Outcome> {
    const repoId = payload.repository?.id != null ? String(payload.repository.id) : null;
    const run = payload.check_run;
    if (!installationId || !repoId || !run?.name) return { status: "ignored" };
    const targets = await this.targetsFor(installationId, repoId);
    if (!targets.length) return { status: "ignored", detail: "not a connected repository" };

    const numbers: number[] = (run.pull_requests ?? []).map((p: { number: number }) => p.number);
    let touched = 0;
    for (const t of targets) {
      const prs = await this.repo.pullRequestsAtHead(t.repo.id, String(run.head_sha));
      const byNumber = numbers.length ? await this.repo.pullRequestsByNumbers(t.repo.id, numbers) : [];
      const mine = new Map([...prs, ...byNumber].map((p) => [p.id, p]));
      for (const pr of mine.values()) {
        if (pr.headSha !== String(run.head_sha)) continue; // a result for a commit that is no longer the head
        const checks: typeof pr.checks = { ...pr.checks, [run.name]: { status: String(run.status), conclusion: run.conclusion ?? null, url: run.html_url ?? null } };
        const next: CheckState | null = ciState(checks);
        await this.repo.updateChecks(pr.id, checks, next);
        touched++;
        if (next !== pr.ciState && (next === "failure" || next === "success")) {
          const links = await this.repo.linkedIssueIds(pr.id);
          const actor = githubActor(t.team.workspaceId, t.team.id);
          for (const l of links) {
            const tk = await this.repo.issueById(l.issueId);
            if (!tk) continue;
            const ref = `${t.team.key}-${tk.number}`;
            const failed = Object.entries(checks).filter(([, c]) => c.status === "completed" && c.conclusion && c.conclusion !== "success" && c.conclusion !== "neutral" && c.conclusion !== "skipped").map(([n]) => n);
            await this.events.emit(actor, t.team.id, {
              type: "issue.ci",
              entity: "issue",
              entityId: tk.id,
              summary: next === "failure" ? `CI failed on pull request #${pr.number} for ${ref}: ${failed.join(", ")}` : `CI passed on pull request #${pr.number} for ${ref}`,
              data: { ref, number: pr.number, ciState: next, failed },
            });
            if (next === "failure") await this.emitter.emitAsync(ISSUE_COMMENT_REQUESTED, { actor, ref, body: `CI failed on pull request [#${pr.number}](${pr.url}): ${failed.join(", ")}` } satisfies IssueCommentRequested);
          }
        }
      }
    }
    return { status: touched ? "handled" : "ignored", matched: touched, detail: touched ? undefined : "no matching pull request" };
  }

  /** Pull requests linked to an issue, newest first, for the issue view and for agents. */
  pullRequestsForIssue(issueId: string) {
    return this.repo.pullRequestsForIssue(issueId);
  }
}
