import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Actor } from "../actor";

/**
 * The actor the guards put on the request: `req.actor` (ActorGuard: an API key or a session, for /mcp and /api/v1), or
 * `req.human.actor` (HumanGuard and SessionGuard: a signed-in person, for /api/app). A route needs one of them.
 */
export function actorOf(req: { actor?: Actor; human?: { actor: Actor } }): Actor | undefined {
  return req.actor ?? req.human?.actor;
}

/** `@CurrentActor() actor: Actor`. Throws if the route has no guard that sets an actor: that is a wiring mistake, not a caller's. */
export const CurrentActor = createParamDecorator((_data: unknown, ctx: ExecutionContext): Actor => {
  const actor = actorOf(ctx.switchToHttp().getRequest());
  if (!actor) throw new Error("@CurrentActor() needs ActorGuard or SessionGuard on the route");
  return actor;
});
