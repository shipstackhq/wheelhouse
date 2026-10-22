import { useState } from "react";
import clsx from "clsx";
import { ChevronDownIcon, CloseIcon, MenuIcon } from "./icons";

/**
 * The frame every left panel shares (the app's sidebar and Settings' panel), so they are the same width and behave the same: a fixed
 * column from tablet up (56 wide, or the 14-wide icon rail when `collapsed`), and on a phone a drawer opened by a menu button, with a
 * dimmed backdrop and a close button. The panel decides what goes inside.
 */
export function SidebarFrame({
  id,
  open,
  onOpen,
  onClose,
  collapsed = false,
  children,
}: {
  id: string;
  /** The phone drawer is showing. */
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** The icon-only rail, tablet and up. */
  collapsed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <>
      <button
        type="button"
        aria-label="Open menu"
        aria-controls={id}
        onClick={onOpen}
        className="fixed left-2 top-2 z-30 rounded-md border border-line bg-panel px-2 py-1 text-sm md:hidden"
      >
        <MenuIcon className="text-lg" />
      </button>
      {open && <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={onClose} />}
      <aside
        id={id}
        data-collapsed={collapsed ? "true" : "false"}
        className={clsx(
          "fixed inset-y-0 left-0 z-40 flex w-56 shrink-0 flex-col border-r border-line bg-panel transition-transform md:static md:translate-x-0 md:transition-[width]",
          collapsed && "md:w-14",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        {children}
      </aside>
    </>
  );
}

/** The phone drawer's close button, for the top row of a panel. Hidden from tablet up, where there is no drawer. */
export function SidebarCloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" aria-label="Close menu" onClick={onClose} className="text-muted md:hidden">
      <CloseIcon className="text-lg" />
    </button>
  );
}

// ───────── titled groups of links ─────────

const GROUPS_KEY = "wh:sidebar-closed-groups";

function readClosedGroups(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(GROUPS_KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * A titled group of links that folds away from its title (the choice is remembered). The title row is the same size as a link row.
 * As the rail the title goes (it would not fit), the links always show, and a thin rule separates the groups instead.
 */
/** Whether a titled section is folded, remembered per title. */
export function useFolded(title: string) {
  const [closed, setClosed] = useState(() => readClosedGroups().includes(title));
  const toggle = () =>
    setClosed((c) => {
      try {
        const rest = readClosedGroups().filter((g) => g !== title);
        localStorage.setItem(GROUPS_KEY, JSON.stringify(c ? rest : [...rest, title]));
      } catch {
        /* the choice just is not remembered */
      }
      return !c;
    });
  return [closed, toggle] as const;
}

export function SectionLabel({ title, closed, onToggle, controls, collapsed, gap, actions }: { title: string; closed: boolean; onToggle: () => void; controls: string; collapsed: boolean; gap: string; actions?: React.ReactNode }) {
  return (
    <div className={clsx("group relative", gap, collapsed && "md:hidden")}>
      {/* The whole row is the toggle (its hover area too); the actions sit above it, on their own layer, so they take their own clicks. */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!closed}
        aria-controls={controls}
        className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-xs font-medium leading-5 text-muted outline-none hover:bg-panel-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        <span className="truncate">{title}</span>
        <ChevronDownIcon aria-hidden className={clsx("shrink-0 text-sm transition-transform duration-150", closed && "-rotate-90")} />
      </button>
      {actions && (
        <span className="absolute right-1 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5 md:opacity-0 md:focus-within:opacity-100 md:group-hover:opacity-100">{actions}</span>
      )}
    </div>
  );
}

/**
 * A titled group of links that folds away from its title (remembered). `scope` keeps groups of the same title in different panels
 * apart ("Workspace" in the app's sidebar and in Settings fold separately).
 */
export function SidebarGroup({ title, scope, collapsed = false, gap, children }: { title: string; scope?: string; collapsed?: boolean; gap: string; children: React.ReactNode }) {
  const key = scope ? `${scope}:${title}` : title;
  const [closed, toggle] = useFolded(key);
  const id = `group-${scope ? `${scope}-` : ""}${title.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <div className={clsx(collapsed && "md:mt-3 md:border-t md:border-line md:pt-3")}>
      <SectionLabel title={title} closed={closed} onToggle={toggle} controls={id} collapsed={collapsed} gap={gap} />
      <div id={id} className={clsx("mt-0.5 space-y-0.5", closed && "hidden", closed && collapsed && "md:block")}>
        {children}
      </div>
    </div>
  );
}
