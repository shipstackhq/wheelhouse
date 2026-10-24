import { Injectable } from "@nestjs/common";
import type { Actor } from "../../common/actor";
import type { Q } from "../database/transaction";
import { emit } from "./emit";

/** The shape of one event, as `emit` takes it. */
export type EventInput = Parameters<typeof emit>[3];

/**
 * Publishes to the event log (events, and the live streams that follow it) without a module importing the legacy service layer.
 * Same contract as `emit`: pass the transaction (q) when the change is in one, so the event commits with it.
 */
@Injectable()
export class EventsService {
  emit(q: Q, actor: Actor, teamId: string, e: EventInput): Promise<void> {
    return emit(q, actor, teamId, e);
  }
}
