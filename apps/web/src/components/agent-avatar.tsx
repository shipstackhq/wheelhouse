import clsx from "clsx";
import { createAvatar } from "@dicebear/core";
import { lorelei, loreleiNeutral, notionists, notionistsNeutral, openPeeps } from "@dicebear/collection";
import type { AvatarStyle } from "@wheelhouse/shared/agents/avatar";

// Rendered locally, never from the hosted DiceBear API. Only the five CC0 styles are listed in shared.
const STYLES: Record<AvatarStyle, Parameters<typeof createAvatar>[0]> = {
  notionists,
  "notionists-neutral": notionistsNeutral,
  lorelei,
  "lorelei-neutral": loreleiNeutral,
  "open-peeps": openPeeps,
};

const cache = new Map<string, string>();

/** The SVG of a face as a data URI. The same style and seed always give the same SVG. */
export function avatarUri({ style, seed }: { style: AvatarStyle; seed: string }): string {
  const key = `${style}\n${seed}`;
  let uri = cache.get(key);
  if (!uri) {
    uri = createAvatar(STYLES[style], { seed }).toDataUri();
    cache.set(key, uri);
  }
  return uri;
}

const SIZES = { sm: "size-5", md: "size-8", lg: "size-14", xl: "size-24" } as const;

/** An agent's face. Its alt is the agent's name, since the face is the only picture of it. */
export function AgentAvatar({ avatar, name, size = "md" }: { avatar: { style: AvatarStyle; seed: string }; name: string; size?: keyof typeof SIZES }) {
  return <img src={avatarUri(avatar)} alt={name} className={clsx("shrink-0 rounded-full bg-panel-2", SIZES[size])} />;
}
