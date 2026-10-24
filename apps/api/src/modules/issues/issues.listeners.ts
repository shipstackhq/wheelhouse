import { Injectable } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { ISSUE_COMMENT_REQUESTED, ISSUE_MOVE_REQUESTED, type IssueCommentRequested, type IssueMoveRequested } from "../github/index";
import { addComment, moveIssue } from "./issues";

/**
 * What the issues module does when github says something happened (github.events.ts). `suppressErrors: false` so a failure here fails
 * the github call that emitted the event, as a direct call would have (the default logs the error and goes on).
 */
@Injectable()
export class IssuesListeners {
  /** A pull request moves its linked issue (opened, merged, closed...). */
  @OnEvent(ISSUE_MOVE_REQUESTED, { suppressErrors: false })
  async onMoveRequested({ actor, ref, status }: IssueMoveRequested) {
    await moveIssue(actor, ref, status);
  }

  /** A pull request or a CI result leaves a comment on its linked issue. */
  @OnEvent(ISSUE_COMMENT_REQUESTED, { suppressErrors: false })
  async onCommentRequested({ actor, ref, body }: IssueCommentRequested) {
    await addComment(actor, ref, body);
  }
}
