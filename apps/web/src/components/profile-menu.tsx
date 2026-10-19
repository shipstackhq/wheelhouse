import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Popover } from "radix-ui";
import clsx from "clsx";
import { useNavigate } from "react-router";
import type { Role } from "@wheelhouse/api-client";
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

/** The person's other workspaces, when they have any: choosing one moves this session there and drops everything read from the old one. */
function WorkspaceSwitcher() {
  const { api, queryClient } = useServices();
  const navigate = useNavigate();
  const query = useQuery({ queryKey: ["me", "workspaces"] as const, queryFn: () => api.workspaces.list() });
  const list = query.data ?? [];
  if (list.length < 2) return null;
  const go = async (id: string) => {
    try {
      await api.workspaces.switchTo(id);
    } catch {
      return; // not offered any more (removed, suspended): the list refreshes on the next open
    }
    queryClient.clear();
    navigate("/", { replace: true });
  };
  return (
    <div className="border-t border-line px-1 py-1" role="group" aria-label="Workspaces">
      <div className="px-2 py-1 text-xs text-muted">Workspaces</div>
      {list.map((w) => (
        <button
          key={w.id}
          type="button"
          disabled={w.active}
          aria-current={w.active ? "true" : undefined}
          onClick={() => go(w.id)}
          className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-panel-2 focus-visible:bg-panel-2 disabled:cursor-default disabled:hover:bg-transparent"
        >
          <span className={clsx("truncate", w.active ? "font-medium text-fg" : "text-muted")}>{w.name}</span>
          <span className="shrink-0 text-xs text-muted">{w.active ? "current" : w.role}</span>
        </button>
      ))}
    </div>
  );
}

/** `compact`: the icon-only sidebar rail (tablet and up), where only the avatar fits; the menu it opens is the same. */
export function ProfileMenu(props: { name: string; email: string; role: Role; tags: string[]; team: string; compact?: boolean }) {
  const compact = !!props.compact;
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
        className={clsx(
          "flex w-full items-center gap-2.5 rounded-md p-2 text-left outline-none hover:bg-panel-2 focus-visible:ring-2 focus-visible:ring-accent/50 data-[state=open]:bg-panel-2",
          compact && "md:justify-center md:p-1",
        )}
        aria-label="Account menu"
      >
        <Avatar name={props.name} email={props.email} />
        <span className={clsx("min-w-0 flex-1", compact && "md:hidden")}>
          <span className="block truncate text-sm text-fg">{props.name}</span>
          <span className="block truncate text-xs text-muted">{props.email}</span>
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side={compact ? "right" : "top"}
          align={compact ? "end" : "start"}
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
          <WorkspaceSwitcher />
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
