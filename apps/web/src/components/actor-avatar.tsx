import type { ActorRef } from "@wheelhouse/api-client";
import { Avatar } from "./avatar";
import { avatarUri } from "./agent-avatar";

/** Anyone's picture: an uploaded image, a generated agent face, or their initials. Decorative: the name is always beside it. */
export function ActorAvatar({ actor, className = "size-5" }: { actor: Pick<ActorRef, "name" | "avatar">; className?: string }) {
  const { avatar, name } = actor;
  if (avatar?.type === "generated") return <img src={avatarUri(avatar)} alt="" aria-hidden title={name} className={`${className} shrink-0 rounded-full bg-panel-2`} data-avatar={name} />;
  return <Avatar name={name} imageUrl={avatar?.type === "image" ? avatar.url : null} className={className} />;
}
