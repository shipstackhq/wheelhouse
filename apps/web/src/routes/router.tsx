import { type RouteObject } from "react-router";
import type { Services } from "../lib/services";
import { AdminInvitesPage, AdminTeamPage, AdminTeamsPage } from "../pages/admin";
import { AgentsPage } from "../pages/agents";
import { ActivityPage } from "../pages/activity/activity";
import { BoardPage } from "../pages/board";
import { DecisionsPage } from "../pages/decisions";
import { GlossaryPage } from "../pages/glossary";
import { MapPage } from "../pages/map";
import { LoginPage, SignupPage } from "../pages/auth";
import { Dashboard } from "../pages/dashboard";
import { InvitePage } from "../pages/invite";
import { NewProjectPage } from "../pages/new-project";
import { TeamPage } from "../pages/team";
import { NotFound, RouteError } from "./errors";
import { redirectIfSignedIn, requireSignedIn } from "./guards";
import { AppLayout, AuthLayout, FullPageSkeleton, InviteLayout, ProjectLayout, RequireAdmin, RootLayout } from "./layouts";
import { OfflinePage } from "./offline";
import { stub } from "./stub";

/** The pages still to be ported (WH-98: docs, repositories, onboarding) are stubs; that ticket replaces its own. */
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
        { path: "invite", Component: InviteLayout, children: [{ index: true, Component: InvitePage }] },
        {
          Component: AuthLayout,
          loader: redirectIfSignedIn(services),
          children: [
            { path: "login", Component: LoginPage },
            { path: "signup", Component: SignupPage },
          ],
        },
        {
          Component: AppLayout,
          loader: requireSignedIn(services),
          children: [
            { index: true, Component: Dashboard },
            { path: "projects/new", Component: NewProjectPage },
            { path: "team", Component: TeamPage },
            { path: "agents", Component: AgentsPage },
            {
              Component: RequireAdmin,
              children: [
                { path: "admin/teams", Component: AdminTeamsPage },
                { path: "admin/teams/:id", Component: AdminTeamPage },
                { path: "admin/invites", Component: AdminInvitesPage },
              ],
            },
            {
              path: "p/:key",
              Component: ProjectLayout,
              children: [
                { index: true, Component: BoardPage },
                { path: "activity", Component: ActivityPage },
                { path: "map", Component: MapPage },
                { path: "docs", Component: stub("Docs", "WH-98") },
                { path: "decisions", Component: DecisionsPage },
                { path: "glossary", Component: GlossaryPage },
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
