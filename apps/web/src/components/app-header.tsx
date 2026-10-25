import { SidebarToggle } from "./sidebar-toggle";
import { useLocation } from "react-router";
import { Breadcrumbs } from "./breadcrumbs";
import { TeamQueueMenu } from "./team-queue-menu";
import { PageMenu } from "./page-menu";
import { NotificationsMenu } from "./notifications-menu";

/**
 * The bar across the top of every signed-in page: where you are (breadcrumbs), and the bots menu when a team is open. On a phone it clears the sidebar's menu button, which floats at the left.
 */
export function AppHeader({ workspaceName, teams, collapsed, onToggleCollapsed }: { workspaceName: string; teams: { key: string; name: string }[]; collapsed: boolean; onToggleCollapsed: () => void }) {
  const { pathname } = useLocation();
  const teamKey = pathname.match(/^\/t\/([^/]+)/)?.[1];
  const team = teamKey ? teams.find((t) => t.key === decodeURIComponent(teamKey)) : undefined;
  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b border-line bg-panel pl-12 pr-4 md:px-5">
      <SidebarToggle collapsed={collapsed} onToggle={onToggleCollapsed} />
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <Breadcrumbs workspaceName={workspaceName} teams={teams} />
        <PageMenu />
      </div>
      <div className="flex items-center gap-2">
        {team && <TeamQueueMenu teamKey={team.key} />}
        <NotificationsMenu />
      </div>
    </header>
  );
}
