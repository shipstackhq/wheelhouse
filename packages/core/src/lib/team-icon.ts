import { ServiceError } from "./service-error";

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

const bad = (field: "icon" | "iconColor", message: string): never => {
  throw new ServiceError("invalid", message, { fields: { [field]: message } });
};

/** One emoji: a single grapheme that has an emoji (pictographic) in it. The system draws it, so nothing is bundled. */
export function isEmoji(v: string): boolean {
  if (!v || v.length > 32) return false;
  const graphemes = [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(v)];
  return graphemes.length === 1 && /\p{Extended_Pictographic}/u.test(v);
}

/** `undefined` leaves it as it is, `null` or an empty string clears it, anything else must be `ri:<a known name>` or one emoji. */
export function parseTeamIcon(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v !== "string") return bad("icon", "icon must be text");
  const s = v.trim();
  if (s.startsWith("ri:")) return (TEAM_ICON_NAMES as readonly string[]).includes(s.slice(3)) ? s : bad("icon", "That icon is not one of the available icons");
  return isEmoji(s) ? s : bad("icon", "Use one of the icons, or a single emoji");
}

export function parseTeamIconColor(v: unknown): TeamIconColor | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  return typeof v === "string" && (TEAM_ICON_COLORS as readonly string[]).includes(v) ? (v as TeamIconColor) : bad("iconColor", `iconColor must be one of ${TEAM_ICON_COLORS.join(", ")}`);
}
