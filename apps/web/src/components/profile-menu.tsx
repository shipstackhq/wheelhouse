import { useState } from "react";
import clsx from "clsx";
import { useNavigate } from "react-router";
import type { Role } from "@wheelhouse/api-client";
import { forgetAppLocation } from "../lib/app-location";
import { useServices } from "../lib/services";
import { ThemeSwitch } from "./theme-toggle";
import { InstallButton, clearOfflineData } from "./pwa";
import { Menu, MenuItem, MenuSeparator } from "./menu";

function initials(name: string, email: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const s = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] ?? email).slice(0, 2);
  return s.toUpperCase();
}

/** Stable hue per user so avatars are distinguishable without uploads. */
function hue(seed: string) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

/** DiceBear "initials" avatar: initials and background colour are derived from the seed. */
export const avatarUrl = (seed: string) => `https://api.dicebear.com/10.x/initials/svg?seed=${encodeURIComponent(seed)}`;

/** `imageUrl`: the person's own uploaded picture; without one (or if it fails to load) the generated initials avatar. */
export function Avatar({ name, email, size = 32, imageUrl }: { name: string; email: string; size?: number; imageUrl?: string | null }) {
  const [failed, setFailed] = useState(false);
  if (!failed) {
    return (
      <img
        src={imageUrl || avatarUrl(name.trim() || email)}
        alt=""
        aria-hidden
        width={size}
        height={size}
        loading="lazy"
        onError={() => setFailed(true)}
        className="shrink-0 select-none rounded-full bg-panel-2"
        style={{ width: size, height: size }}
      />
    );
  }
  // Offline / blocked: local initials so the avatar never disappears.
  const h = hue(email);
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, fontSize: size * 0.38, background: `hsl(${h} 45% 42%)` }}
    >
      {initials(name, email)}
    </span>
  );
}

/** `compact`: the icon-only sidebar rail (tablet and up), where only the avatar fits; the menu it opens is the same. */
export function ProfileMenu(props: { name: string; email: string; role: Role; tags: string[]; workspace: string; imageUrl?: string | null; compact?: boolean }) {
  const compact = !!props.compact;
  const { api, queryClient } = useServices();
  const navigate = useNavigate();
  async function signOut() {
    await clearOfflineData();
    try {
      await api.auth.logout();
    } catch {
      /* the server could not be reached: the person still leaves; the session expires on its own */
    } finally {
      queryClient.clear(); // nothing from this person's session may linger in memory
      forgetAppLocation();
      navigate("/login", { replace: true });
    }
  }
  return (
    <Menu
      side={compact ? "right" : "top"}
      align={compact ? "end" : "start"}
      className="w-64"
      trigger={
        <button
          type="button"
          className={clsx(
            "flex w-full items-center gap-2.5 rounded-md p-2 text-left outline-none hover:bg-panel-2 focus-visible:ring-2 focus-visible:ring-accent/50 data-[state=open]:bg-panel-2",
            compact && "md:justify-center md:p-1",
          )}
          aria-label="Account menu"
        >
          <Avatar name={props.name} email={props.email} imageUrl={props.imageUrl} />
          <span className={clsx("min-w-0 flex-1", compact && "md:hidden")}>
            <span className="block truncate text-sm text-fg">{props.name}</span>
            <span className="block truncate text-xs text-muted">{props.email}</span>
          </span>
        </button>
      }
    >
      <div className="flex items-center gap-3 p-3">
        <Avatar name={props.name} email={props.email} size={40} imageUrl={props.imageUrl} />
        <div className="min-w-0">
          <div className="truncate font-medium">{props.name}</div>
          <div className="truncate text-xs text-muted">{props.email}</div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1 px-3 pb-3 text-xs">
        <span className="text-muted">{props.workspace}</span>
        <span className="text-muted">·</span>
        <span className={clsx("chip", props.role === "owner" ? "bg-accent/15 text-accent" : "bg-panel-2 text-fg")}>{props.role}</span>
        {props.tags.map((t) => (
          <span key={t} className="chip bg-bg text-muted">{t}</span>
        ))}
      </div>
      <MenuSeparator />
      <div className="px-3 py-3">
        <ThemeSwitch />
      </div>
      <MenuSeparator />
      <InstallButton />
      <MenuItem onSelect={signOut} className="text-muted">Sign out</MenuItem>
    </Menu>
  );
}
