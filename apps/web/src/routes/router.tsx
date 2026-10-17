import { type RouteObject } from "react-router";
import type { Services } from "../lib/services";
import { AdminInvitesPage, AdminTeamPage, AdminTeamsPage } from "../pages/admin";
import { AgentsPage } from "../pages/agents";
import { ActivityPage } from "../pages/activity/activity";
import { BoardPage } from "../pages/board";
import { DecisionsPage } from "../pages/decisions";
import { DocsPage } from "../pages/docs";
import { GlossaryPage } from "../pages/glossary";
import { OnboardingPage } from "../pages/onboarding";
import { ReposPage } from "../pages/repos";
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
                { path: "docs", Component: DocsPage },
                { path: "docs/:docId", Component: DocsPage },
                { path: "decisions", Component: DecisionsPage },
                { path: "glossary", Component: GlossaryPage },
                { path: "repos", Component: ReposPage },
                { path: "onboarding", Component: OnboardingPage },
              ],
            },
            { path: "*", Component: NotFound },
          ],
        },
      ],
    },
  ];
}
