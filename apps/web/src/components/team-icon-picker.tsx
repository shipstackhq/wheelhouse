import { useState } from "react";
import clsx from "clsx";
import { Popover } from "radix-ui";
import { isEmoji, TEAM_ICON_COLORS, TEAM_ICON_NAMES, type TeamIconColor } from "@wheelhouse/shared/team-icon";
import { TEAM_ICONS } from "./icons";
import { ICON_COLOR_CLASS, TeamIcon } from "./team-icon";

const EMOJI_PRESETS = ["🚀", "🛠️", "🔒", "💳", "✉️", "📦", "🧪", "📊", "🎨", "🌍", "⚡", "🔥", "🌱", "🧭", "🏗️", "🤖"];
const BOX = "z-60 rounded-lg border border-line bg-panel p-2 text-fg shadow-xl";
const CELL = "grid size-9 place-items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent/50";

/**
 * A team's icon: its preview, and two popovers to change it, one of Remix icons with a colour, one of emoji (whatever the system's emoji
 * font draws; pick a common one, or type or paste one). A pick is saved at once: `onSave` gets what to store (`ri:<name>` or the emoji)
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
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const typedBad = typed.trim() !== "" && !isEmoji(typed.trim());
  const pickEmoji = (e: string) => (setEmojiOpen(false), setTyped(""), props.onSave(e, null));
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <span className="grid size-8 place-items-center rounded-lg border border-line bg-panel-2 text-xl">
        <TeamIcon team={{ key: props.teamKey, icon: props.icon, iconColor: props.iconColor }} />
      </span>
      {props.canEdit && (
        <>
          <Popover.Root>
            <Popover.Trigger className="btn" disabled={props.pending}>Icon</Popover.Trigger>
            <Popover.Portal>
              <Popover.Content align="end" sideOffset={6} collisionPadding={8} className={clsx(BOX, "w-80 space-y-3")}>
                <div role="group" aria-label="Icon" className="grid max-h-64 grid-cols-8 gap-1 overflow-y-auto">
                  {TEAM_ICON_NAMES.map((n) => {
                    const Icon = TEAM_ICONS[n];
                    return (
                      <button key={n} type="button" aria-label={n.replace(/-\d+$/, "").replace(/-/g, " ")} aria-pressed={ri === n} onClick={() => props.onSave(`ri:${n}`, color)} className={clsx(CELL, "text-lg", ri === n ? "bg-accent/15 text-accent" : "text-muted hover:bg-panel-2 hover:text-fg")}>
                        <Icon aria-hidden />
                      </button>
                    );
                  })}
                </div>
                <div role="group" aria-label="Colour" className="flex flex-wrap gap-2 px-1 pb-1">
                  {TEAM_ICON_COLORS.map((c) => (
                    <button key={c} type="button" aria-label={c} aria-pressed={color === c} onClick={() => props.onSave(ri ? props.icon : null, c)} className={clsx("size-6 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent/50", ICON_COLOR_CLASS[c].bg, color === c ? "ring-2 ring-fg ring-offset-2 ring-offset-panel" : "opacity-80 hover:opacity-100")} />
                  ))}
                </div>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          <Popover.Root open={emojiOpen} onOpenChange={setEmojiOpen}>
            <Popover.Trigger className="btn" disabled={props.pending}>Emoji</Popover.Trigger>
            <Popover.Portal>
              <Popover.Content align="end" sideOffset={6} collisionPadding={8} className={clsx(BOX, "w-72 space-y-2")}>
                <div role="group" aria-label="Common emoji" className="grid grid-cols-8 gap-1">
                  {EMOJI_PRESETS.map((e) => (
                    <button key={e} type="button" aria-label={e} aria-pressed={props.icon === e} onClick={() => pickEmoji(e)} className={clsx(CELL, "text-xl", props.icon === e ? "bg-accent/15" : "hover:bg-panel-2")}>
                      {e}
                    </button>
                  ))}
                </div>
                <form className="flex gap-2" onSubmit={(e) => (e.preventDefault(), typed.trim() && !typedBad && pickEmoji(typed.trim()))}>
                  <input className="input min-w-0 flex-1" aria-label="Emoji" placeholder="Type or paste an emoji" value={typed} maxLength={16} onChange={(e) => setTyped(e.target.value)} aria-invalid={typedBad || undefined} />
                  <button type="submit" className="btn" disabled={!typed.trim() || typedBad}>Use</button>
                </form>
                {typedBad && <p className="text-xs text-danger" role="alert">Use a single emoji.</p>}
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
