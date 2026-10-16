import { type RouteObject } from "react-router";
import { TeamLiveRefresh } from "../components/live-refresh";
import type { Services } from "../lib/services";
import { NotFound, RouteError } from "./errors";
import { redirectIfSignedIn, requireSignedIn } from "./guards";
import { AppLayout, AuthLayout, FullPageSkeleton, ProjectLayout, RequireAdmin, RootLayout } from "./layouts";
import { OfflinePage } from "./offline";
import { PageStub, stub } from "./stub";

/** The page-port tickets replace these stubs one by one. */
function Dashboard() {
  return (
    <>
      <TeamLiveRefresh />
      <PageStub title="Home" owner="WH-95" />
    </>
  );
}

/**
 * Every address the Next app serves, at the same address, so links, bookmarks and the links the plugin prints keep working.
 * The auth gate is a loader: it runs before anything renders.
 */
export function buildRoutes(services: Services): RouteObject[] {
  return [
    {
      id: "root",
      Component: RootLayout,
      ErrorBoundary: RouteError,
      HydrateFallback: FullPageSkeleton,
      children: [
        { path: "offline", Component: OfflinePage },
        { path: "invite", Component: stub("Accept an invite", "WH-95") },
        {
          Component: AuthLayout,
          loader: redirectIfSignedIn(services),
          children: [
            { path: "login", Component: stub("Sign in", "WH-95") },
            { path: "signup", Component: stub("Create your account", "WH-95") },
          ],
        },
        {
          Component: AppLayout,
          loader: requireSignedIn(services),
          children: [
            { index: true, Component: Dashboard },
            { path: "projects/new", Component: stub("New project", "WH-95") },
            { path: "team", Component: stub("Members", "WH-95") },
            { path: "agents", Component: stub("Agents & API keys", "WH-95") },
            {
              Component: RequireAdmin,
              children: [
                { path: "admin/teams", Component: stub("Teams", "WH-95") },
                { path: "admin/teams/:id", Component: stub("Team", "WH-95") },
                { path: "admin/invites", Component: stub("Invite a new team", "WH-95") },
              ],
            },
            {
              path: "p/:key",
              Component: ProjectLayout,
              children: [
                { index: true, Component: stub("Board", "WH-96") },
                { path: "activity", Component: stub("Activity", "WH-97") },
                { path: "map", Component: stub("Map", "WH-97") },
                { path: "docs", Component: stub("Docs", "WH-98") },
                { path: "decisions", Component: stub("Decisions", "WH-97") },
                { path: "glossary", Component: stub("Glossary", "WH-97") },
                { path: "repos", Component: stub("Repositories", "WH-98") },
                { path: "onboarding", Component: stub("Set up this project", "WH-98") },
              ],
            },
            { path: "*", Component: NotFound },
          ],
        },
      ],
    },
  ];
}
