import { Inject, Injectable, Logger } from "@nestjs/common";
import { isUuid } from "../../common/uuid";
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
      await this.inbox.notify({
        workspaceId: issue.workspaceId,
        teamId: issue.teamId,
        recipientUserId: job.createdBy,
        source: "wheelhouse",
        type: ok ? "run.finished" : "run.failed",
        title: ok ? `Run on ${ref} finished` : `Run on ${ref} failed`,
        body: ok ? issue.title : [issue.title, (job.error ?? "").slice(0, SNIPPET)].filter(Boolean).join("\n"),
        actorKind: "agent",
        actorId: device.id,
        actorName: device.name,
        subjectEntity: "issue",
        subjectId: job.issueId,
        href: `/t/${issue.teamKey}?t=${ref}`,
        data: { jobId: job.id, state: job.state, branch: job.branch },
        dedupeKey: `${ok ? "run.finished" : "run.failed"}:${job.id}`,
      });
    } catch (e) {
      this.log.warn(`run notification failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}
