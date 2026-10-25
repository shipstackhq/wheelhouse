import { useState } from "react";
import { Navigate, Outlet, useNavigate } from "react-router";
import { ArrowLeftIcon, SETTINGS_ICONS, type IconPair } from "../../components/icons";
import { NavLink } from "../../components/nav-link";
import { SidebarCloseButton, SidebarFrame, SidebarGroup } from "../../components/sidebar-frame";
import { NavigationProgress } from "../../components/navigation-progress";
import { FullPageSkeleton } from "../../routes/layouts";
import { lastAppLocation } from "../../lib/app-location";
import { useMe } from "../../lib/session";
import { INTEGRATIONS } from "../integrations/integrations";

const ITEMS: { group: string; items: { to: string; label: string; icon?: IconPair }[] }[] = [
  {
    group: "Personal",
    items: [
      { to: "/settings/profile", label: "Profile", icon: SETTINGS_ICONS.profile },
      { to: "/settings/password", label: "Password", icon: SETTINGS_ICONS.password },
      { to: "/settings/devices", label: "Devices", icon: SETTINGS_ICONS.devices },
    ],
  },
  {
    group: "Workspace",
    items: [
      { to: "/settings/workspace", label: "General", icon: SETTINGS_ICONS.general },
      { to: "/settings/members", label: "Members", icon: SETTINGS_ICONS.members },
      { to: "/settings/api-keys", label: "API keys", icon: SETTINGS_ICONS.agents },
      { to: "/settings/teams", label: "Teams", icon: SETTINGS_ICONS.teams },
    ],
  },
  { group: "Integrations", items: INTEGRATIONS.map((i) => ({ to: i.to, label: i.label, icon: i.icon })) },
];

/**
 * Settings as a screen of its own: a left panel with Back to app (to the page you were on) and the settings sections, and the chosen
 * section beside it. The panel is the app sidebar's frame (same width, same phone drawer) with Settings' own links in it. It is not inside the app's sidebar and header. Signed-out and not-found behave as everywhere else.
 */
export function SettingsLayout() {
  const me = useMe().data;
  const navigate = useNavigate();
  const [open, setOpen] = useState(false); // the phone drawer
  if (me === null) return <Navigate to="/login" replace />;
  if (!me) return <FullPageSkeleton />;
  return (
    <div className="flex h-dvh">
      <NavigationProgress />
      <SidebarFrame id="settings-sidebar" open={open} onOpen={() => setOpen(true)} onClose={() => setOpen(false)}>
        <div className="flex items-center justify-between gap-2 px-3 py-3">
          <button
            type="button"
            onClick={() => navigate(lastAppLocation())}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left text-sm text-muted outline-none hover:bg-panel-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <ArrowLeftIcon className="shrink-0 text-base" />
            <span className="truncate">Back to app</span>
          </button>
          <SidebarCloseButton onClose={() => setOpen(false)} />
        </div>
        <div className="truncate px-4 pb-1 text-xs text-muted">{me.workspace.name}</div>
        {/* A link closes the phone drawer, so the chosen section is what shows. */}
        <nav aria-label="Settings" className="flex-1 overflow-y-auto px-2 pb-3 text-sm" onClick={(e) => (e.target as HTMLElement).closest("a") && setOpen(false)}>
          {ITEMS.map((g) => (
            <SidebarGroup key={g.group} title={g.group} scope="settings" gap="mt-3">
              {g.items.map((i) => (
                <NavLink key={i.to} href={i.to} icon={i.icon}>
                  {i.label}
                </NavLink>
              ))}
            </SidebarGroup>
          ))}
        </nav>
      </SidebarFrame>
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
