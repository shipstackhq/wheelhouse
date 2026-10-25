import { Inject, Injectable } from "@nestjs/common";
import { Database } from "../../platform/database/database";
import { deferPublish } from "../../platform/events/event-bus";

/** The type of the one live signal the inbox sends: "this person's inbox changed, fetch it again". */
export const INBOX_CHANGED = "inbox.changed";

/**
 * Tells the open streams of one person that their inbox changed. The signal names no item and carries no title, body or actor: a
 * stream forwards only `type` (and nothing of the recipient), and the browser refetches what it shows. It goes through the event
 * bus with `recipientUserId` set, so the streams filter it down to that person's connections. Inside a transaction it is held
 * until the commit, like every other signal.
 */
@Injectable()
export class InboxSignal {
  constructor(@Inject(Database) private readonly db: Database) {}

  /** `workspaceId` is null for an instance-level item: the signal goes to the person's streams in any workspace. */
  changed(who: { userId: string; workspaceId: string | null }, teamId: string | null) {
    deferPublish(this.db.q, { workspaceId: who.workspaceId, teamId, type: INBOX_CHANGED, recipientUserId: who.userId });
  }
}
