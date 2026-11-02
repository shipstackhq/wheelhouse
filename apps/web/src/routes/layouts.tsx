import { useEffect } from "react";
import { Navigate, Outlet, useMatches, useParams } from "react-router";
import clsx from "clsx";
import { Logo } from "../components/logo";
import { NavigationProgress } from "../components/navigation-progress";
import { ProfileMenu } from "../components/profile-menu";
import { AppHeader } from "../components/app-header";
import { PwaRegister } from "../components/pwa";
import { InboxLiveRefresh } from "../components/inbox-live-refresh";
import { TeamLiveRefresh } from "../components/live-refresh";
import { PageSkeleton } from "../components/skeleton";
import { Sidebar } from "../components/sidebar";
import { TeamStatusBar } from "../components/team-status-bar";
import { useSidebarCollapsed } from "../components/sidebar-toggle";
import { PageMenuProvider } from "../components/page-menu";
import { useRememberAppLocation } from "../lib/app-location";
import { useMe, useTeams } from "../lib/session";
import { useWsPathname } from "../lib/workspace";
import { NotFound } from "./errors";

/** Shown by the router while the first screen's data (who you are, your teams) loads. */
export function FullPageSkeleton() {
  return (
    <div className="h-dvh">
      <PageSkeleton label="Loading Wheelhouse" />
    </div>
  );
}

/** Everything under it: the service worker registration and, below, whichever layout the address calls for. */
export function RootLayout() {
  return (
    <>
      <Outlet />
      <PwaRegister />
    </>
  );
}

/** Sign-in and sign-up: the logo, the tagline and the form, centred on the page with no card around them. */
export function AuthLayout() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <Logo className="text-lg" />
          <p className="mt-2 text-sm text-muted">The board your team and your AI agents share.</p>
        </div>
        <Outlet />
      </div>
    </main>
  );
}

/**
 * The invite page. The link carries a secret in its fragment, so: never index it, never send it as a referrer. (The page is one
 * shared HTML file, so these are set here, as the page opens, rather than in the document the server sends.)
 */
export function InviteLayout() {
  useEffect(() => {
    const before = document.title;
    document.title = "Join Wheelhouse";
    const tags = [
      Object.assign(document.createElement("meta"), { name: "robots", content: "noindex, nofollow" }),
      Object.assign(document.createElement("meta"), { name: "referrer", content: "no-referrer" }),
    ];
    tags.forEach((t) => document.head.appendChild(t));
    return () => {
      document.title = before;
      tags.forEach((t) => t.remove());
    };
  }, []);
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <Logo className="text-lg" />
          <p className="mt-2 text-sm text-muted">You have been invited.</p>
        </div>
        <div className="card p-6">
          <Outlet />
        </div>
      </div>
    </main>
  );
}

/** The signed-in app: the sidebar, the header with its breadcrumbs, and whichever page the address calls for. */
/** A route's `handle`: `fullWidth` pages fill the space beside the sidebar, `narrow` ones sit in a centred column no wider than 4xl; the others, no wider than 7xl. */
export interface PageHandle {
  fullWidth?: boolean;
  narrow?: boolean;
}

export function AppLayout() {
  const me = useMe().data;
  const teams = useTeams().data;
  const handles = useMatches().map((m) => m.handle as PageHandle | undefined);
  const fullWidth = handles.some((h) => h?.fullWidth);
  const narrow = handles.some((h) => h?.narrow);
  // The dashboard and the team pages already have a stream that refreshes the inbox with everything else; the other pages open one for it.
  const pathname = useWsPathname();
  const hasStream = pathname === "/" || pathname.startsWith("/t/");
  useRememberAppLocation(); // Settings is its own screen: this is where its Back to app goes
  const [collapsed, toggleCollapsed] = useSidebarCollapsed(); // the sidebar's rail, toggled from the header
  // The session ended while the page was open (signed out in another tab, expired): the cache says so, go and sign in.
  if (me === null) return <Navigate to="/login" replace />;
  if (!me || !teams) return <FullPageSkeleton />;
  return (
    <PageMenuProvider>
      <div className="flex h-dvh">
        <NavigationProgress />
        {!hasStream && <InboxLiveRefresh />}
        <Sidebar
          collapsed={collapsed}
          teams={teams.map((p) => ({ key: p.key, name: p.name, icon: p.icon, iconColor: p.iconColor, retired: p.retired }))}
          workspaceName={me.workspace.name}
          workspaceImageUrl={me.workspace.imageUrl}
          isAdmin={me.isInstanceAdmin}
          profile={(collapsed) => <ProfileMenu name={me.user.name} email={me.user.email} role={me.role} tags={me.tags} workspace={me.workspace.name} imageUrl={me.user.avatarUrl} compact={collapsed} />}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <AppHeader workspaceName={me.workspace.name} teams={teams.map((p) => ({ key: p.key, name: p.name }))} collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
          <main className="min-h-0 flex-1 overflow-hidden">
            <div className={fullWidth ? "h-full" : clsx("mx-auto h-full", narrow ? "max-w-4xl" : "max-w-7xl")}>
              <Outlet />
            </div>
          </main>
        </div>
      </div>
    </PageMenuProvider>
  );
}

/** One team: live updates for it, and its page. A team that is not this workspace's is simply not found. */
export function TeamLayout() {
  const { key = "" } = useParams();
  const team = useTeams().data?.find((p) => p.key === key);
  if (!team) return <NotFound />;
  return (
    <div className="flex h-full flex-col">
      <TeamLiveRefresh teamKey={team.key} />
      <TeamStatusBar teamKey={team.key} />
      <div className="min-h-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}

/** Pages only an instance administrator may see. The server refuses the data too; this just does not show the page. */
export function RequireAdmin() {
  const me = useMe().data;
  return me?.isInstanceAdmin ? <Outlet /> : <NotFound />;
}
