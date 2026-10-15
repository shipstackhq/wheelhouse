"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { LinkPending } from "./link-pending";

export function NavLink({ href, prefix, children }: { href: string; prefix?: boolean; children: React.ReactNode }) {
  const path = usePathname();
  const active = prefix ? path === href || path.startsWith(href + "/") : path === href;
  return (
    <Link
      href={href}
      className={clsx(
        "block truncate rounded-md px-2 py-1.5",
        active ? "bg-panel-2 text-fg" : "text-muted hover:bg-panel-2 hover:text-fg",
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="min-w-0 flex-1 truncate">{children}</span>
        <LinkPending />
      </span>
    </Link>
  );
}
