import { useState } from "react";
import { Popover } from "radix-ui";
import clsx from "clsx";
import { useNavigate } from "react-router";
import { useServices } from "../lib/services";
import { ThemeSwitch } from "./theme-toggle";
import { InstallButton, clearOfflineData } from "./pwa";

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

export function Avatar({ name, email, size = 32 }: { name: string; email: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (!failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- remote SVG, no optimisation needed
      <img
        src={avatarUrl(name.trim() || email)}
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

export function ProfileMenu(props: { name: string; email: string; role: "owner" | "member"; tags: string[]; team: string }) {
  const { api, queryClient } = useServices();
  const navigate = useNavigate();
  async function signOut(e: React.FormEvent) {
    e.preventDefault();
    await clearOfflineData();
    try {
      await api.auth.logout();
    } catch {
      /* the server could not be reached: the person still leaves; the session expires on its own */
    } finally {
      queryClient.clear(); // nothing from this person's session may linger in memory
      navigate("/login", { replace: true });
    }
  }
  return (
    <Popover.Root>
      <Popover.Trigger
        className="flex w-full items-center gap-2.5 rounded-md p-2 text-left outline-none hover:bg-panel-2 focus-visible:ring-2 focus-visible:ring-accent/50 data-[state=open]:bg-panel-2"
        aria-label="Account menu"
      >
        <Avatar name={props.name} email={props.email} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-fg">{props.name}</span>
          <span className="block truncate text-xs text-muted">{props.email}</span>
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          className="z-50 w-64 rounded-lg border border-line bg-panel p-1 text-fg shadow-xl"
        >
          <div className="flex items-center gap-3 p-3">
            <Avatar name={props.name} email={props.email} size={40} />
            <div className="min-w-0">
              <div className="truncate font-medium">{props.name}</div>
              <div className="truncate text-xs text-muted">{props.email}</div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1 px-3 pb-3 text-xs">
            <span className="text-muted">{props.team}</span>
            <span className="text-muted">·</span>
            <span className={clsx("chip", props.role === "owner" ? "bg-accent/15 text-accent" : "bg-panel-2 text-fg")}>{props.role}</span>
            {props.tags.map((t) => (
              <span key={t} className="chip bg-bg text-muted">{t}</span>
            ))}
          </div>
          <div className="border-t border-line px-3 py-3">
            <ThemeSwitch />
          </div>
          <div className="border-t border-line p-1">
            <InstallButton />
            <form onSubmit={signOut}>
            <button className="w-full rounded-md px-2 py-1.5 text-left text-sm text-muted outline-none hover:bg-panel-2 hover:text-fg focus-visible:bg-panel-2">
              Sign out
            </button>
            </form>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
