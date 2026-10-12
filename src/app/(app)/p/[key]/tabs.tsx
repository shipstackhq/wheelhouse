"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";

export function ProjectTabs({ projectKey }: { projectKey: string }) {
  const path = usePathname();
  const base = `/p/${projectKey}`;
  const tabs = [
    { href: base, label: "Board" },
    { href: `${base}/map`, label: "Map" },
    { href: `${base}/decisions`, label: "Decisions" },
    { href: `${base}/glossary`, label: "Glossary" },
    { href: `${base}/activity`, label: "Activity" },
  ];
  return (
    <nav className="flex gap-1 text-sm">
      {tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={clsx("rounded-md px-3 py-1", path === t.href ? "bg-panel-2 text-fg" : "text-muted hover:text-fg")}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
