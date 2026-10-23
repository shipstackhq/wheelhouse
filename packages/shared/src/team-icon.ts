/**
 * A team's icon (shown in the sidebar): either one of these Remix icons, stored as `ri:<name>` and drawn in the team's colour, or a single
 * emoji, stored as the emoji itself and drawn by the system's own emoji font. A short list rather than the whole Remix set, so the app
 * ships only the icons it can show; add a name here and its component in the web app's team-icon registry (a type check enforces the pair).
 */
export const TEAM_ICON_NAMES = [
  "rocket-2", "box-3", "flag-2", "star", "heart", "flashlight", "fire", "leaf", "plant", "global", "cloud", "shield", "lock", "key",
  "mail", "chat-1", "bank-card", "wallet", "shopping-cart", "store-2", "tools", "settings-3", "code-box", "terminal-box", "bug",
  "database-2", "server", "cpu", "palette", "brush", "camera", "music-2", "gamepad", "book", "graduation-cap", "stethoscope",
  "plane", "car", "ship", "home", "building-2", "map-pin", "compass-3", "lightbulb", "magic", "trophy", "medal", "line-chart",
  "pie-chart", "bar-chart", "time", "calendar", "anchor", "puzzle", "user", "team", "customer-service", "megaphone", "gift", "sun",
] as const;
export type TeamIconName = (typeof TEAM_ICON_NAMES)[number];

/** The colours an icon can take (the web app maps each to a class). */
export const TEAM_ICON_COLORS = ["slate", "sky", "emerald", "amber", "rose", "violet", "teal", "orange", "fuchsia", "lime", "indigo"] as const;
export type TeamIconColor = (typeof TEAM_ICON_COLORS)[number];

/** One emoji: a single grapheme that has an emoji (pictographic) in it. The system draws it, so nothing is bundled. */
export function isEmoji(v: string): boolean {
  if (!v || v.length > 32) return false;
  const graphemes = [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(v)];
  return graphemes.length === 1 && /\p{Extended_Pictographic}/u.test(v);
}
