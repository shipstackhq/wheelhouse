import { Inject, Injectable, Logger } from "@nestjs/common";
import { ServiceError } from "../../common/service-error";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { UserDirectory } from "../auth/index";
import { NotificationsService } from "../notifications/index";
import { broadcastInput, type BroadcastAudience, type BroadcastInput, type ParsedBroadcastInput } from "./dto/broadcasts.dto";
import { BroadcastsRepository, type BroadcastRow } from "./broadcasts.repository";

/** How many people one insert reaches. */
export const BATCH = 500;

/**
 * Sends one message to an audience, as an inbox item for each person. Fan-out is in batches (resolve a page of people, insert their items
 * in one statement), and each item's dedupe key is the broadcast's own, so a send that is repeated or resumed after a crash creates only
 * what is missing: calling `send` again with the same key finishes a broadcast that stopped halfway, and does nothing to one that is done.
 *
 * The items are instance-level (no workspace): the person sees them in each workspace of theirs, and reads and archives them once.
 */
@Injectable()
export class BroadcastsService {
  private readonly log = new Logger("Broadcasts");

  constructor(
    @Inject(BroadcastsRepository) private readonly repo: BroadcastsRepository,
    @Inject(NotificationsService) private readonly inbox: NotificationsService,
    @Inject(UserDirectory) private readonly directory: UserDirectory,
  ) {}

  async send(input: BroadcastInput): Promise<BroadcastRow> {
    const b = new ZodValidationPipe(broadcastInput).transform(input);
    const row = await this.repo.findOrCreate(b);
    if (!sameMessage(row, b)) throw new ServiceError("conflict", `Broadcast "${b.key}" was already sent with different content; use a new key`);
    if (row.status === "done") return row;

    await this.repo.markSending(row.id);
    try {
      let after: string | null = null;
      for (;;) {
        const ids = await this.audiencePage(b.audience, after);
        if (!ids.length) break;
        const created = await this.inbox.notifyMany(
          ids.map((recipientUserId) => ({
            workspaceId: null,
            recipientUserId,
            source: b.source,
            type: b.type,
            title: b.title,
            body: b.body,
            bodyFormat: b.bodyFormat,
            href: b.href ?? null,
            actorKind: "system" as const,
            actorName: b.actorName,
            dedupeKey: `broadcast:${b.key}`,
            broadcastId: row.id,
          })),
        );
        await this.repo.addDelivered(row.id, created);
        after = ids[ids.length - 1];
        if (ids.length < BATCH) break;
      }
      await this.repo.markDone(row.id);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log.warn(`broadcast ${b.key} stopped: ${message}`);
      await this.repo.markFailed(row.id, message);
      throw e;
    }
    return (await this.repo.get(row.id)) ?? row;
  }

  /** The next page of people in the audience after `after`. */
  private audiencePage(audience: BroadcastAudience, after: string | null): Promise<string[]> {
    switch (audience.kind) {
      case "everyone":
        return this.directory.idsAfter(after, BATCH);
    }
  }
}

/** The same key must mean the same message: a changed title or audience under an old key is a mistake, not a new send. */
function sameMessage(row: BroadcastRow, b: ParsedBroadcastInput): boolean {
  return (
    row.source === b.source &&
    row.type === b.type &&
    row.title === b.title &&
    row.body === b.body &&
    row.bodyFormat === b.bodyFormat &&
    (row.href ?? null) === (b.href ?? null) &&
    row.actorName === b.actorName &&
    JSON.stringify(row.audience) === JSON.stringify(b.audience)
  );
}
