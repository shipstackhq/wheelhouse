import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Actor } from "../../common/actor";
import { isUuid } from "../../common/uuid";
import { NotificationsService, type NotificationInput } from "../notifications/index";
import { IssuesRepository, type IssueRow } from "./issues.repository";

type Team = { id: string; key: string; workspaceId: string };

const SNIPPET = 1000;

/** The start of a comment, cut at a paragraph or word so the markdown is not left mid-word; the rest is one click away on the issue. */
function excerpt(text: string): string {
  if (text.length <= SNIPPET) return text;
  const head = text.slice(0, SNIPPET);
  const cut = Math.max(head.lastIndexOf("\n\n"), head.lastIndexOf(" "), head.lastIndexOf("\n"));
  return `${(cut > SNIPPET / 2 ? head.slice(0, cut) : head).trimEnd()}…`;
}

/**
 * What an issue tells people, as inbox items (humans only; never the person who did it). Called by IssuesService AFTER the change has
 * committed, never inside its transaction: a failed insert (a person deleted meanwhile) would abort the whole Postgres transaction even if
 * the error were caught, and the change must not fail for a notification. Each method swallows and logs its own failure.
 *
 * The dedupe key names the change, not just the issue: an assignment and a move carry the issue's new version (every change bumps it,
 * so the same commit sent again is one item and a later change is another); a comment carries the comment's id.
 */
@Injectable()
export class IssueNotifications {
  private readonly log = new Logger("IssueNotifications");

  constructor(
    @Inject(NotificationsService) private readonly inbox: NotificationsService,
    @Inject(IssuesRepository) private readonly repo: IssuesRepository,
  ) {}

  /** The issue is now assigned to a person: tell them (not when they assigned it to themselves). */
  assigned(actor: Actor, team: Team, issue: IssueRow, ref: string) {
    if (!issue.assigneeId) return Promise.resolve();
    return this.send(actor, team, issue, [issue.assigneeId], (userId) => ({
      type: "issue.assigned",
      title: `${ref} assigned to you`,
      body: issue.title,
      dedupeKey: `issue.assigned:${issue.id}:v${issue.version}`,
      recipientUserId: userId,
    }));
  }

  /** WH-117: someone other than the assignee delegated their issue to an agent: tell the assignee, who still owns it. */
  delegated(actor: Actor, team: Team, issue: IssueRow, ref: string, agent: string) {
    if (!issue.assigneeId) return Promise.resolve();
    return this.send(actor, team, issue, [issue.assigneeId], (userId) => ({
      type: "issue.delegated",
      title: `${actor.name} asked ${agent} to work on ${ref}`,
      body: issue.title,
      dedupeKey: `issue.delegated:${issue.id}:v${issue.version}`,
      recipientUserId: userId,
    }));
  }

  /** A comment on the issue: its creator and its assignee, one item each. */
  commented(actor: Actor, team: Team, issue: IssueRow, ref: string, comment: { id: string; body: string }) {
    return this.send(actor, team, issue, this.people(issue), (userId) => ({
      type: "issue.commented",
      title: `${actor.name} commented on ${ref}`,
      body: excerpt(comment.body),
      bodyFormat: "markdown",
      dedupeKey: `issue.commented:${comment.id}`,
      recipientUserId: userId,
    }));
  }

  /** The issue went to a status whose role is review: its creator and its assignee. */
  movedToReview(actor: Actor, team: Team, issue: IssueRow, ref: string) {
    return this.send(actor, team, issue, this.people(issue), (userId) => ({
      type: "issue.review",
      title: `${ref} is ready for review`,
      body: issue.title,
      dedupeKey: `issue.review:${issue.id}:v${issue.version}`,
      recipientUserId: userId,
    }));
  }

  /** The issue's creator (when a person) and assignee. */
  private people(issue: IssueRow): string[] {
    return [issue.createdByKind === "human" ? issue.createdById : null, issue.assigneeId].filter((id): id is string => !!id);
  }

  private async send(actor: Actor, team: Team, issue: IssueRow, ids: string[], item: (userId: string) => Partial<NotificationInput>) {
    try {
      for (const userId of new Set(ids)) {
        if (!isUuid(userId) || (actor.kind === "human" && userId === actor.id)) continue;
        // Someone no longer on the team gets nothing: they could not open the issue the item points to.
        if (!(await this.repo.isTeamMember(team.id, userId))) continue;
        const input: NotificationInput = {
          source: "wheelhouse",
          workspaceId: team.workspaceId,
          teamId: team.id,
          title: "",
          type: "",
          recipientUserId: userId,
          ...item(userId),
          actorKind: actor.system ? "system" : actor.kind,
          actorId: isUuid(actor.id) ? actor.id : null,
          actorName: actor.name,
          subjectEntity: "issue",
          subjectId: issue.id,
          href: `/t/${team.key}?t=${team.key}-${issue.number}`,
        };
        await this.inbox.notify(input).catch((e) => this.fail(input.type, e));
      }
    } catch (e) {
      this.fail("notify", e);
    }
  }

  private fail(what: string, e: unknown) {
    this.log.warn(`${what} notification failed: ${e instanceof Error ? e.message : e}`);
  }
}
