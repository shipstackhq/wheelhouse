import { Link, useLocation } from "react-router";
import clsx from "clsx";
import type { IconPair } from "./icons";
import { LinkPending, useLinkPending } from "./link-pending";
import { Tip } from "./tip";

/**
 * A sidebar link. With an `icon` pair, the place you are on shows the solid icon and the others the outline one. `collapsed` is
 * the icon-only rail (tablet and up): the label stays for screen readers, and a tooltip names the place. On a phone the drawer is
 * always full width, so none of the collapsed styling applies there.
 */
export function NavLink({ href, prefix, icon, collapsed = false, children }: { href: string; prefix?: boolean; icon?: IconPair; collapsed?: boolean; children: React.ReactNode }) {
  const { pathname } = useLocation();
  const active = prefix ? pathname === href || pathname.startsWith(href + "/") : pathname === href;
  const pending = useLinkPending(href);
  const Icon = icon ? (active ? icon.fill : icon.line) : null;
  const link = (
    <Link
      to={href}
      aria-current={active ? "page" : undefined}
      className={clsx(
        "flex items-center gap-2.5 rounded-md px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
        collapsed && "md:justify-center md:px-0 md:py-1.5",
        active ? "bg-panel-2 text-fg" : "text-muted hover:bg-panel-2 hover:text-fg",
      )}
    >
      {Icon && <Icon className={clsx("shrink-0 text-base", collapsed && "md:text-lg", active && "text-accent")} />}
      <span className={clsx("min-w-0 flex-1 truncate", collapsed && "md:sr-only")}>{children}</span>
      <LinkPending pending={pending} className={collapsed ? "h-3 w-3 md:hidden" : undefined} />
    </Link>
  );
  return collapsed ? (
    <Tip content={children} side="right" align="center">
      {link}
    </Tip>
  ) : (
    link
  );
}
