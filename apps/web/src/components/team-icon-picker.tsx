import { useState } from "react";
import clsx from "clsx";
import { isEmoji, TEAM_ICON_COLORS, TEAM_ICON_NAMES, type TeamIconColor } from "@wheelhouse/core/lib/team-icon";
import { TEAM_ICONS } from "./icons";
import { ICON_COLOR_CLASS, TeamIcon } from "./team-icon";

const EMOJI_PRESETS = ["🚀", "🛠️", "🔒", "💳", "✉️", "📦", "🧪", "📊", "🎨", "🌍", "⚡", "🔥", "🌱", "🧭", "🏗️", "🤖"];

/**
 * Choose a team's icon: one of the Remix icons with a colour, or a single emoji (whatever the system's emoji font draws; type or paste
 * one, or pick a common one). `onSave` gets what to store (`ri:<name>` or the emoji) and the colour; a `null` icon is the default glyph.
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
  const startsAsEmoji = !!props.icon && !props.icon.startsWith("ri:");
  const [mode, setMode] = useState<"icon" | "emoji">(startsAsEmoji ? "emoji" : "icon");
  const [name, setName] = useState<string | null>(props.icon?.startsWith("ri:") ? props.icon.slice(3) : null);
  const [color, setColor] = useState<TeamIconColor | null>((TEAM_ICON_COLORS as readonly string[]).includes(props.iconColor ?? "") ? (props.iconColor as TeamIconColor) : null);
  const [emoji, setEmoji] = useState(startsAsEmoji ? props.icon! : "");
  const emojiBad = mode === "emoji" && emoji.trim() !== "" && !isEmoji(emoji.trim());
  const chosen = mode === "emoji" ? (emoji.trim() && !emojiBad ? emoji.trim() : null) : name ? `ri:${name}` : null;
  const preview = { key: props.teamKey, icon: chosen, iconColor: mode === "icon" ? color : null };
  const changed = chosen !== props.icon || (mode === "icon" && (color ?? null) !== (props.iconColor ?? null));
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <span className="grid size-12 place-items-center rounded-lg border border-line bg-panel-2 text-3xl">
          <TeamIcon team={preview} />
        </span>
        <div role="tablist" aria-label="Kind of icon" className="flex gap-1 text-sm">
          {(["icon", "emoji"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              disabled={!props.canEdit}
              onClick={() => setMode(m)}
              className={clsx("rounded-md px-3 py-1 outline-none focus-visible:ring-2 focus-visible:ring-accent/50", mode === m ? "bg-panel-2 text-fg" : "text-muted hover:text-fg")}
            >
              {m === "icon" ? "Icon" : "Emoji"}
            </button>
          ))}
        </div>
      </div>

      {mode === "icon" ? (
        <>
          <div role="group" aria-label="Icon" className="grid grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))] gap-1">
            {TEAM_ICON_NAMES.map((n) => {
              const Icon = TEAM_ICONS[n];
              return (
                <button
                  key={n}
                  type="button"
                  aria-label={n.replace(/-\d+$/, "").replace(/-/g, " ")}
                  aria-pressed={name === n}
                  disabled={!props.canEdit}
                  onClick={() => setName(n)}
                  className={clsx("grid size-9 place-items-center rounded-md text-lg outline-none focus-visible:ring-2 focus-visible:ring-accent/50", name === n ? "bg-accent/15 text-accent" : "text-muted hover:bg-panel-2 hover:text-fg")}
                >
                  <Icon aria-hidden />
                </button>
              );
            })}
          </div>
          <div role="group" aria-label="Colour" className="flex flex-wrap gap-2">
            {TEAM_ICON_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                aria-pressed={color === c}
                disabled={!props.canEdit}
                onClick={() => setColor(c)}
                className={clsx("size-6 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent/50", ICON_COLOR_CLASS[c].bg, color === c ? "ring-2 ring-fg ring-offset-2 ring-offset-bg" : "opacity-80 hover:opacity-100")}
              />
            ))}
          </div>
        </>
      ) : (
        <div className="space-y-2">
          <input
            className="input w-40 text-xl"
            aria-label="Emoji"
            placeholder="Type or paste an emoji"
            value={emoji}
            maxLength={16}
            disabled={!props.canEdit}
            onChange={(e) => setEmoji(e.target.value)}
            aria-invalid={emojiBad || undefined}
          />
          {emojiBad && <p className="text-sm text-danger" role="alert">Use a single emoji. Your system&apos;s emoji picker (Ctrl+Cmd+Space on a Mac, Win+. on Windows) works here.</p>}
          <div role="group" aria-label="Common emoji" className="flex flex-wrap gap-1">
            {EMOJI_PRESETS.map((e) => (
              <button key={e} type="button" aria-label={e} aria-pressed={emoji === e} disabled={!props.canEdit} onClick={() => setEmoji(e)} className={clsx("grid size-9 place-items-center rounded-md text-xl outline-none focus-visible:ring-2 focus-visible:ring-accent/50", emoji === e ? "bg-accent/15" : "hover:bg-panel-2")}>
                {e}
              </button>
            ))}
          </div>
        </div>
      )}

      {props.error && <p className="text-sm text-danger" role="alert">{props.error}</p>}
      {props.canEdit && (
        <div className="flex gap-2">
          <button type="button" className="btn btn-primary" disabled={props.pending || emojiBad || !changed} onClick={() => props.onSave(chosen, mode === "icon" ? color : null)}>
            Save icon
          </button>
          <button type="button" className="btn" disabled={props.pending || (!props.icon && !props.iconColor)} onClick={() => props.onSave(null, null)}>
            Use the default
          </button>
        </div>
      )}
    </div>
  );
}
