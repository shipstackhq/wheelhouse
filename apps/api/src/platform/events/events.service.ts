import { Inject, Injectable } from "@nestjs/common";
import type { Actor } from "../../common/actor";
import { Database } from "../database/database";
import { emit } from "./emit";

/** The shape of one event, as `emit` takes it. */
export type EventInput = Parameters<typeof emit>[3];

/**
 * Publishes to the event log (events, and the live streams that follow it). It writes on `Database.q`, so inside a transaction the
 * event commits with the change and the live signal waits for the commit. Code that is not converted yet calls `emit(q, ...)`.
 */
@Injectable()
export class EventsService {
  constructor(@Inject(Database) private readonly db: Database) {}

  emit(actor: Actor, teamId: string, e: EventInput): Promise<void> {
    return emit(this.db.q, actor, teamId, e);
  }
}
