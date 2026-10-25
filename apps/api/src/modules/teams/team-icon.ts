import { ServiceError } from "../../common/service-error";
import { isEmoji, TEAM_ICON_COLORS, TEAM_ICON_NAMES, type TeamIconColor } from "@wheelhouse/shared/team-icon";

// The icons, colours and the emoji check are shared with the web app (packages/shared); only the parsing of a request is the server's.
export * from "@wheelhouse/shared/team-icon";

const bad = (field: "icon" | "iconColor", message: string): never => {
  throw new ServiceError("invalid", message, { fields: { [field]: message } });
};

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
