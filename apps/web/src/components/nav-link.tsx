import { Link, useLocation } from "react-router";
import clsx from "clsx";
import { LinkPending, useLinkPending } from "./link-pending";

export function NavLink({ href, prefix, children }: { href: string; prefix?: boolean; children: React.ReactNode }) {
  const { pathname } = useLocation();
  const active = prefix ? pathname === href || pathname.startsWith(href + "/") : pathname === href;
  const pending = useLinkPending(href);
  return (
    <Link
      to={href}
      className={clsx(
        "block truncate rounded-md px-2 py-1.5",
        active ? "bg-panel-2 text-fg" : "text-muted hover:bg-panel-2 hover:text-fg",
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="min-w-0 flex-1 truncate">{children}</span>
        <LinkPending pending={pending} />
      </span>
    </Link>
  );
}
