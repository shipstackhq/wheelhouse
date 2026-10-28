import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Actor } from "../../common/actor";
import { isUuid } from "../../common/uuid";
import { effectiveProfile } from "../agents/index";
import { NotificationsService } from "../notifications/index";
import { DaemonRepository, type DeviceRow, type JobRow } from "./daemon.repository";

const SNIPPET = 300;

/**
 * Tells the person who started a run how it ended (an inbox item, humans only: `createdBy` is always a person, since only a person
 * sends work to their machine). Called after the finish has been recorded, outside any transaction, and it never throws: a missing
 * person or issue, or a failed insert, is logged and the finish stands. The dedupe key is the job id and outcome, so a finish sent
 * again is one item.
 */
@Injectable()
export class RunNotifications {
  private readonly log = new Logger("RunNotifications");

  constructor(
    @Inject(NotificationsService) private readonly inbox: NotificationsService,
    @Inject(DaemonRepository) private readonly repo: DaemonRepository,
  ) {}

  async finished(device: DeviceRow, job: JobRow) {
    try {
      if (!isUuid(job.createdBy) || (job.state !== "succeeded" && job.state !== "failed")) return;
      const issue = await this.repo.issueForNotice(job.issueId);
      if (!issue) return;
      const ref = `${issue.teamKey}-${issue.number}`;
      const ok = job.state === "succeeded";
      const question = typeof job.result?.question === "string" ? job.result.question : null;
      const who = await this.who(job);
      // The requester, and the assignee when someone else started it (WH-127: the issue stays theirs).
      for (const recipientUserId of new Set([job.createdBy, ...(isUuid(issue.assigneeId) ? [issue.assigneeId] : [])])) {
        await this.inbox.notify({
          workspaceId: issue.workspaceId,
          teamId: issue.teamId,
          recipientUserId,
          source: "wheelhouse",
          type: question ? "run.question" : ok ? "run.finished" : "run.failed",
          title: question ? `${who} has a question on ${ref}` : ok ? `Run on ${ref} finished` : `Run on ${ref} failed`,
          body: question ? question.slice(0, SNIPPET) : ok ? issue.title : [issue.title, (job.error ?? "").slice(0, SNIPPET)].filter(Boolean).join("\n"),
          actorKind: "agent",
          actorId: device.id,
          actorName: device.name,
          subjectEntity: "issue",
          subjectId: job.issueId,
          href: `/t/${issue.teamKey}?t=${ref}`,
          data: { jobId: job.id, state: job.state, branch: job.branch },
          dedupeKey: `${question ? "run.question" : ok ? "run.finished" : "run.failed"}:${job.id}`,
        });
      }
    } catch (e) {
      this.log.warn(`run notification failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** The agent's own name for a run ("Arlo", not its CLI name), or a plain "The run" when no agent was named. */
  private async who(job: JobRow) {
    const row = job.agentId ? await this.repo.workspaceAgent(job.agentId, job.workspaceId) : undefined;
    return row ? effectiveProfile(row).name : "The run";
  }

  /**
   * WH-119: every run leaves one comment on its issue, as the agent: what it said at the end with a verdict, or its question (WH-118).
   * Called once per run, by the finish that moved it. Never throws.
   */
  async summary(device: DeviceRow, job: JobRow) {
    try {
      const who = await this.who(job);
      const said = (await this.repo.lastResultEvent(job.id))?.data?.text;
      const text = typeof said === "string" ? said.trim().slice(0, 1500) : "";
      const question = typeof job.result?.question === "string" ? job.result.question : null;
      const files = (job.result?.diffStats as { files?: number | null } | undefined)?.files;
      const body = question
        ? `**${who} has a question:**\n\n${question}`
        : job.state === "succeeded" && job.mode === "review"
          ? [`**${who} reviewed the pull request.**`, text].filter(Boolean).join("\n\n")
          : job.state === "succeeded"
          ? [`**${who} finished.**`, text, `Branch \`${job.branch}\`${files ? ` · ${files} file${files === 1 ? "" : "s"} changed` : ""}`].filter(Boolean).join("\n\n")
          : job.state === "failed"
            ? `**${who}'s run failed.**\n\n${job.error ?? ""}`.trim()
            : `**${who}'s run was stopped.**`;
      await this.repo.insertComment({ issueId: job.issueId, authorKind: "agent", authorId: job.agentId ?? device.id, authorName: who, body });
    } catch (e) {
      this.log.warn(`run summary comment failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** WH-130: a delegated issue has no targets, so nothing can start until someone says where. Once per delegation (the dedupe key has its time), to the requester. */
  async needsSetup(requester: Actor, issue: { id: string; teamId: string; workspaceId: string; title: string; delegatedAt: Date | null }, ref: string) {
    try {
      await this.inbox.notify({
        workspaceId: issue.workspaceId,
        teamId: issue.teamId,
        recipientUserId: requester.id,
        source: "wheelhouse",
        type: "run.needs_setup",
        title: `${ref} needs a repository and branch before the agent can start`,
        body: issue.title,
        actorKind: "agent",
        actorId: issue.id,
        actorName: "Wheelhouse",
        subjectEntity: "issue",
        subjectId: issue.id,
        href: `/t/${ref.split("-")[0]}?t=${ref}`,
        dedupeKey: `run.needs_setup:${issue.id}:${issue.delegatedAt?.getTime() ?? 0}`,
      });
    } catch (e) {
      this.log.warn(`needs-setup notification failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}
