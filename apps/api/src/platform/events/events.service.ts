import { Injectable } from "@nestjs/common";
import type { Actor } from "@wheelhouse/core/lib/access";
import { emit, type Q } from "@wheelhouse/core/lib/service";

/** The shape of one event, as core's emit takes it. */
export type EventInput = Parameters<typeof emit>[3];

/**
 * Publishes to the event log (events, and the live streams that follow it) without a module importing core's service layer.
 * Same contract as core's emit: pass the transaction (q) when the change is in one, so the event commits with it.
 */
@Injectable()
export class EventsService {
  emit(q: Q, actor: Actor, teamId: string, e: EventInput): Promise<void> {
    return emit(q, actor, teamId, e);
  }
}
