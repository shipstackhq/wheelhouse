import clsx from "clsx";
import { TEAM_ICON_COLORS, type TeamIconColor, type TeamIconName } from "@wheelhouse/shared/team-icon";
import { TEAM_ICONS, TeamGlyphIcon } from "./icons";

/** Each colour as a literal class (Tailwind only keeps the classes it can read), and as a swatch. */
export const ICON_COLOR_CLASS: Record<TeamIconColor, { text: string; bg: string }> = {
  slate: { text: "text-slate-400", bg: "bg-slate-400" },
  sky: { text: "text-sky-500", bg: "bg-sky-500" },
  emerald: { text: "text-emerald-500", bg: "bg-emerald-500" },
  amber: { text: "text-amber-500", bg: "bg-amber-500" },
  rose: { text: "text-rose-500", bg: "bg-rose-500" },
  violet: { text: "text-violet-500", bg: "bg-violet-500" },
  teal: { text: "text-teal-500", bg: "bg-teal-500" },
  orange: { text: "text-orange-500", bg: "bg-orange-500" },
  fuchsia: { text: "text-fuchsia-500", bg: "bg-fuchsia-500" },
  lime: { text: "text-lime-500", bg: "bg-lime-500" },
  indigo: { text: "text-indigo-500", bg: "bg-indigo-500" },
};

/** With no icon chosen, a team's glyph is coloured from its key: the same on every visit and for everyone. */
const fallbackColor = (key: string): TeamIconColor => {
  const pool = TEAM_ICON_COLORS.filter((c) => c !== "slate");
  return pool[[...key].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7) % pool.length];
};

/**
 * A team's icon: its emoji (drawn by the system, in its own colours), its chosen Remix icon in its colour, or, when nothing is chosen, the
 * default glyph in a colour taken from its key. `className` sets the size (an emoji takes the same text size).
 */
export function TeamIcon({ team, className }: { team: { key: string; icon?: string | null; iconColor?: string | null }; className?: string }) {
  const icon = team.icon ?? null;
  if (icon && !icon.startsWith("ri:")) {
    return (
      <span aria-hidden className={clsx("inline-flex shrink-0 items-center justify-center leading-none", className)}>
        {icon}
      </span>
    );
  }
  const color = (TEAM_ICON_COLORS as readonly string[]).includes(team.iconColor ?? "") ? (team.iconColor as TeamIconColor) : fallbackColor(team.key);
  const Icon = icon ? TEAM_ICONS[icon.slice(3) as TeamIconName] ?? TeamGlyphIcon : TeamGlyphIcon;
  return <Icon aria-hidden className={clsx(className, ICON_COLOR_CLASS[color].text)} />;
}
