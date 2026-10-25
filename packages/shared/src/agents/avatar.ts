// DiceBear styles licensed CC0, so no attribution is needed. Rendering lives in the web app.
export const AVATAR_STYLES = ["notionists", "notionists-neutral", "lorelei", "lorelei-neutral", "open-peeps"] as const;
export type AvatarStyle = (typeof AVATAR_STYLES)[number];
export const DEFAULT_AVATAR_STYLE: AvatarStyle = "notionists";

export function randomSeed(): string {
  return Math.random().toString(36).slice(2, 10);
}
