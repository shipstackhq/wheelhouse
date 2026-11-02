import { useState } from "react";
import clsx from "clsx";
import { Popover } from "radix-ui";
import { TEAM_ICON_COLORS, TEAM_ICON_NAMES, type TeamIconColor } from "@wheelhouse/shared/team-icon";
import { TEAM_ICONS } from "./icons";
import { ICON_COLOR_CLASS, TeamIcon } from "./team-icon";

const EMOJI_PRESETS = [
  "🚀", "🛠️", "🔒", "💳", "✉️", "📦", "🧪", "📊", "🎨", "🌍", "⚡", "🔥", "🌱", "🧭", "🏗️", "🤖",
  "💡", "🎯", "🏆", "⭐", "❤️", "💎", "🔑", "🧩", "📈", "📚", "📝", "📅", "📣", "🔔", "💬", "📞",
  "💻", "📱", "🖥️", "⚙️", "🔧", "🔬", "🧬", "🧠", "🎓", "🏠", "🏢", "🏦", "🛒", "🛍️", "💰", "🪙",
  "🚚", "✈️", "🚗", "🚢", "🌈", "☀️", "🌙", "☁️", "🌊", "🏔️", "🌳", "🍀", "🌸", "🐝", "🦄", "🐙",
  "🎮", "🎵", "🎬", "📷", "🍕", "☕", "🍎", "🎁", "🎉", "🧊", "🛡️", "🕹️", "👥", "🙌", "👀", "✅",
];
const BOX = "z-60 rounded-lg border border-line bg-panel p-2 text-fg shadow-xl";
const CELL = "grid size-9 place-items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent/50";

/**
 * A team's icon: its preview, which opens a popover with a pill switch between Remix icons and emoji, and a colour button beside it (whatever the system's emoji
 * font draws; pick one from the list). A pick is saved at once: `onSave` gets what to store (`ri:<name>` or the emoji)
 * and the colour; a `null` icon is the default glyph.
 */
export function TeamIconPicker(props: {
  teamKey: string;
  icon: string | null;
  iconColor: string | null;
  canEdit: boolean;
  pending?: boolean;
  error?: string | null;
  onSave: (icon: string | null, iconColor: string | null) => void;
}) {
  const ri = props.icon?.startsWith("ri:") ? props.icon.slice(3) : null;
  const color = (TEAM_ICON_COLORS as readonly string[]).includes(props.iconColor ?? "") ? (props.iconColor as TeamIconColor) : null;
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"icon" | "emoji">(ri || !props.icon ? "icon" : "emoji");
  const pickEmoji = (e: string) => (setOpen(false), props.onSave(e, null));
  const preview = <TeamIcon team={{ key: props.teamKey, icon: props.icon, iconColor: props.iconColor }} />;
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {!props.canEdit ? (
        <span className="grid size-[34px] place-items-center rounded-md border border-line bg-panel-2 text-xl">{preview}</span>
      ) : (
        <>
          <Popover.Root>
            <Popover.Trigger aria-label="Colour" className="btn size-[34px] !p-0" disabled={props.pending}>
              <span className={clsx("size-5 rounded-full", color ? ICON_COLOR_CLASS[color].bg : "bg-muted")} aria-hidden />
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content align="end" sideOffset={6} collisionPadding={8} className={clsx(BOX, "w-56")}>
                <div role="group" aria-label="Colour" className="flex flex-wrap gap-2 p-1">
                  {TEAM_ICON_COLORS.map((c) => (
                    <button key={c} type="button" aria-label={c} aria-pressed={color === c} onClick={() => props.onSave(ri ? props.icon : null, c)} className={clsx("size-6 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent/50", ICON_COLOR_CLASS[c].bg, color === c ? "ring-2 ring-fg ring-offset-2 ring-offset-panel" : "opacity-80 hover:opacity-100")} />
                  ))}
                </div>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          <Popover.Root open={open} onOpenChange={setOpen}>
            <Popover.Trigger aria-label="Change icon" className="btn size-[34px] !p-0 text-xl" disabled={props.pending}>{preview}</Popover.Trigger>
            <Popover.Portal>
              <Popover.Content align="end" sideOffset={6} collisionPadding={8} className={clsx(BOX, "w-80 space-y-2")}>
                <div role="tablist" aria-label="Kind of icon" className="flex w-fit gap-0.5 rounded-full bg-panel-2 p-0.5 text-xs">
                  {(["icon", "emoji"] as const).map((t) => (
                    <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={clsx("rounded-full px-3 py-1 outline-none focus-visible:ring-2 focus-visible:ring-accent/50", tab === t ? "bg-panel text-fg shadow-sm" : "text-muted hover:text-fg")}>
                      {t === "icon" ? "Icon" : "Emoji"}
                    </button>
                  ))}
                </div>
                {tab === "icon" ? (
                  <div role="group" aria-label="Icon" className="grid max-h-64 grid-cols-8 gap-1 overflow-y-auto overscroll-contain">
                    {TEAM_ICON_NAMES.map((n) => {
                      const Icon = TEAM_ICONS[n];
                      return (
                        <button key={n} type="button" aria-label={n.replace(/-\d+$/, "").replace(/-/g, " ")} aria-pressed={ri === n} onClick={() => props.onSave(`ri:${n}`, color)} className={clsx(CELL, "text-lg", ri === n ? "bg-accent/15 text-accent" : "text-muted hover:bg-panel-2 hover:text-fg")}>
                          <Icon aria-hidden />
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div role="group" aria-label="Common emoji" className="grid max-h-64 grid-cols-8 gap-1 overflow-y-auto overscroll-contain">
                      {EMOJI_PRESETS.map((e) => (
                        <button key={e} type="button" aria-label={e} aria-pressed={props.icon === e} onClick={() => pickEmoji(e)} className={clsx(CELL, "text-xl", props.icon === e ? "bg-accent/15" : "hover:bg-panel-2")}>
                          {e}
                        </button>
                      ))}
                  </div>
                )}
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          <button type="button" className="btn" disabled={props.pending || (!props.icon && !props.iconColor)} onClick={() => props.onSave(null, null)}>
            Use the default
          </button>
        </>
      )}
      {props.error && <p className="w-full text-right text-sm text-danger" role="alert">{props.error}</p>}
    </div>
  );
}
