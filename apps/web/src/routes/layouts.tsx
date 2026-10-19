import { useEffect } from "react";
import { Navigate, Outlet, useParams } from "react-router";
import { Logo } from "../components/logo";
import { NavigationProgress } from "../components/navigation-progress";
import { SearchIcon } from "../components/icons";
import { NotificationsMenu } from "../components/notifications-menu";
import { ProfileMenu } from "../components/profile-menu";
import { ProjectQueueMenu } from "../components/project-queue-menu";
import { PwaRegister } from "../components/pwa";
import { ProjectLiveRefresh } from "../components/live-refresh";
import { PageSkeleton } from "../components/skeleton";
import { Sidebar } from "../components/sidebar";
import { useMe, useProjects } from "../lib/session";
import { NotFound } from "./errors";

/** Shown by the router while the first screen's data (who you are, your projects) loads. */
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

/** The signed-in app: the sidebar around whichever page the address calls for. */
export function AppLayout() {
  const me = useMe().data;
  const projects = useProjects().data;
  // The session ended while the page was open (signed out in another tab, expired): the cache says so, go and sign in.
  if (me === null) return <Navigate to="/login" replace />;
  if (!me || !projects) return <FullPageSkeleton />;
  return (
    <div className="flex h-dvh">
      <NavigationProgress />
      <Sidebar
        projects={projects.map((p) => ({ key: p.key, name: p.name }))}
        workspaceName={me.workspace.name}
        isAdmin={me.isInstanceAdmin}
        profile={(collapsed) => <ProfileMenu name={me.user.name} email={me.user.email} role={me.role} tags={me.tags} workspace={me.workspace.name} compact={collapsed} />}
      />
      <main className="min-w-0 flex-1 overflow-hidden pt-10 md:pt-0">
        <Outlet />
      </main>
    </div>
  );
}

/** One project: its header, live updates for it, and its page. A project that is not this workspace's is simply not found. */
export function ProjectLayout() {
  const { key = "" } = useParams();
  const project = useProjects().data?.find((p) => p.key === key);
  if (!project) return <NotFound />;
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-4 border-b border-line bg-panel px-5 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate font-semibold">{project.name}</h1>
          </div>
        </div>
        {/* Dummy for now: the one search across tickets, docs and notes (WH-66) is not wired up yet. */}
        <div className="relative mx-auto hidden w-full max-w-md sm:block">
          <input
            type="search"
            className="input !rounded-full !border-line !bg-panel-2 !py-1.5 !pl-9 text-sm focus:!border-accent"
            placeholder="Search docs, tickets, notes"
            aria-label="Search docs, tickets, notes"
          />
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-base text-muted" />
        </div>
        <div className="ml-auto flex items-center gap-2 sm:ml-0">
          <NotificationsMenu />
          <ProjectQueueMenu projectKey={project.key} />
        </div>
      </header>
      <ProjectLiveRefresh projectKey={project.key} />
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
