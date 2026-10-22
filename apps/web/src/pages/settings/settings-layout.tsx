import { Navigate, Outlet, useNavigate } from "react-router";
import clsx from "clsx";
import { ArrowLeftIcon, SETTINGS_ICONS, type IconPair } from "../../components/icons";
import { NavLink } from "../../components/nav-link";
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
      { to: "/settings/agents", label: "Agents & API keys", icon: SETTINGS_ICONS.agents },
      { to: "/settings/teams", label: "Teams", icon: SETTINGS_ICONS.teams },
    ],
  },
  { group: "Integrations", items: INTEGRATIONS.map((i) => ({ to: i.to, label: i.label, icon: i.icon })) },
];

/**
 * Settings as a screen of its own: a left panel with Back to app (to the page you were on) and the settings sections, and the chosen
 * section beside it. It is not inside the app's sidebar and header. Signed-out and not-found behave as everywhere else.
 */
export function SettingsLayout() {
  const me = useMe().data;
  const navigate = useNavigate();
  if (me === null) return <Navigate to="/login" replace />;
  if (!me) return <FullPageSkeleton />;
  return (
    <div className="flex h-dvh flex-col md:flex-row">
      <NavigationProgress />
      <aside className="flex shrink-0 flex-col border-b border-line bg-panel md:w-60 md:border-b-0 md:border-r">
        <div className="p-3">
          <button
            type="button"
            onClick={() => navigate(lastAppLocation())}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted outline-none hover:bg-panel-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <ArrowLeftIcon className="text-lg" />
            Back to app
          </button>
        </div>
        <div className="px-4 pb-2 text-xs text-muted md:pb-1">{me.workspace.name}</div>
        <nav aria-label="Settings" className={clsx("flex gap-4 overflow-x-auto px-2 pb-3 text-sm md:flex-1 md:flex-col md:gap-0 md:overflow-y-auto")}>
          {ITEMS.map((g) => (
            <div key={g.group} className="flex shrink-0 items-center gap-1 md:mt-3 md:block md:space-y-0.5">
              <div className="label hidden px-2 normal-case tracking-normal md:block">{g.group}</div>
              {g.items.map((i) => (
                <NavLink key={i.to} href={i.to} icon={i.icon}>
                  {i.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
