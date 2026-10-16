import { Navigate, Outlet, useParams } from "react-router";
import { Logo } from "../components/logo";
import { NavigationProgress } from "../components/navigation-progress";
import { ProfileMenu } from "../components/profile-menu";
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

/** Sign-in and sign-up: a centred card. */
export function AuthLayout() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <Logo className="text-lg" />
          <p className="mt-2 text-sm text-muted">The board your team and your AI agents share.</p>
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
        teamName={me.team.name}
        isAdmin={me.isInstanceAdmin}
        profile={<ProfileMenu name={me.user.name} email={me.user.email} role={me.role} tags={me.tags} team={me.team.name} />}
      />
      <main className="min-w-0 flex-1 overflow-hidden pt-10 md:pt-0">
        <Outlet />
      </main>
    </div>
  );
}

/** One project: its header, live updates for it, and its page. A project that is not this team's is simply not found. */
export function ProjectLayout() {
  const { key = "" } = useParams();
  const project = useProjects().data?.find((p) => p.key === key);
  if (!project) return <NotFound />;
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-4 border-b border-line px-5 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="chip bg-accent/15 font-mono text-accent">{project.key}</span>
            <h1 className="truncate font-semibold">{project.name}</h1>
          </div>
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
