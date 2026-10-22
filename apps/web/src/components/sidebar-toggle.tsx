import { useState } from "react";
import { CollapseSidebarIcon, ExpandSidebarIcon } from "./icons";
import { Tip } from "./tip";

/** The key the sidebar's icon-only rail is remembered under. */
export const SIDEBAR_COLLAPSED_KEY = "wh:sidebar-collapsed";

/** Whether the person last left the sidebar as the icon-only rail. Storage can be blocked or empty: then it is open. */
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** The sidebar's collapsed state, for the app layout: the header's toggle and the sidebar read the same value. */
export function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, c ? "0" : "1");
      } catch {
        /* the choice just is not remembered */
      }
      return !c;
    });
  return [collapsed, toggle] as const;
}

/** Collapses the sidebar to its icon-only rail, or opens it again. Tablet and up only: on a phone the sidebar is a drawer. */
export function SidebarToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <Tip content={collapsed ? "Expand sidebar" : "Collapse sidebar"} side="bottom" align="start">
      <button
        type="button"
        onClick={onToggle}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-expanded={!collapsed}
        aria-controls="app-sidebar"
        className="hidden shrink-0 rounded-md p-1 text-lg text-muted outline-none hover:bg-panel-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50 md:inline-flex"
      >
        {collapsed ? <ExpandSidebarIcon /> : <CollapseSidebarIcon />}
      </button>
    </Tip>
  );
}
