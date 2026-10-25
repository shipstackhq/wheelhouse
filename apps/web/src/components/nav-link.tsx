import { Link, useLocation } from "react-router";
import clsx from "clsx";
import type { IconPair } from "./icons";
import { LinkPending, useLinkPending } from "./link-pending";
import { Tip } from "./tip";

/** The one size of a sidebar item (links, team rows): padding, gap and icon, as the full row and as the icon-only rail. */
export const NAV_ITEM = "flex items-center gap-2.5 rounded-md px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-accent/50";
export const NAV_ITEM_RAIL = "md:justify-center md:px-0 md:py-1.5";
export const NAV_ICON = "shrink-0 text-base";
export const NAV_ICON_RAIL = "md:text-lg";

/**
 * A sidebar link. With an `icon` pair, the place you are on shows the solid icon and the others the outline one. `collapsed` is
 * the icon-only rail (tablet and up): the label stays for screen readers, and a tooltip names the place. On a phone the drawer is
 * always full width, so none of the collapsed styling applies there.
 */
export function NavLink({ href, prefix, icon, collapsed = false, badge = 0, children }: { href: string; prefix?: boolean; icon?: IconPair; collapsed?: boolean; /** A count shown at the end of the row (a dot on the rail); hidden at 0. */ badge?: number; children: React.ReactNode }) {
  const { pathname } = useLocation();
  const active = prefix ? pathname === href || pathname.startsWith(href + "/") : pathname === href;
  const pending = useLinkPending(href);
  const Icon = icon ? (active ? icon.fill : icon.line) : null;
  const link = (
    <Link
      to={href}
      aria-current={active ? "page" : undefined}
      className={clsx(
        NAV_ITEM,
        collapsed && NAV_ITEM_RAIL,
        badge > 0 && collapsed && "md:relative",
        active ? "bg-panel-2 text-fg" : "text-muted hover:bg-panel-2 hover:text-fg",
      )}
    >
      {Icon && <Icon className={clsx(NAV_ICON, collapsed && NAV_ICON_RAIL, active && "text-accent")} />}
      <span className={clsx("min-w-0 flex-1 truncate", collapsed && "md:sr-only")}>{children}</span>
      {badge > 0 && (
        <span className={clsx("rounded-full bg-accent px-1.5 text-[11px] font-medium leading-4 text-accent-fg", collapsed && "md:absolute md:right-1 md:top-0.5 md:h-2 md:w-2 md:overflow-hidden md:p-0 md:text-[0px]")}>
          {badge > 99 ? "99+" : badge}
          <span className="sr-only"> unread</span>
        </span>
      )}
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
