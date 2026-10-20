import { type RouteObject } from "react-router";
import type { Services } from "../lib/services";
import { AdminInvitesPage, AdminWorkspacePage, AdminWorkspacesPage } from "../pages/admin";
import { AgentsPage } from "../pages/agents";
import { SettingsPage } from "../pages/settings";
import { ActivityPage } from "../pages/activity/activity";
import { BoardPage } from "../pages/board";
import { DecisionsPage } from "../pages/decisions";
import { DocsPage } from "../pages/docs";
import { GlossaryPage } from "../pages/glossary";
import { OnboardingPage } from "../pages/onboarding";
import { CyclePage, CyclesPage } from "../pages/cycles";
import { InitiativePage, InitiativesPage } from "../pages/initiatives";
import { ProjectPage, ProjectsPage } from "../pages/projects";
import { ReposPage } from "../pages/repos";
import { MapPage } from "../pages/map";
import { TeamMembersPage } from "../pages/members";
import { TeamOverviewPage } from "../pages/overview";
import { TeamSettingsPage } from "../pages/team-settings";
import { LoginPage, SignupPage } from "../pages/auth";
import { Dashboard } from "../pages/dashboard";
import { InvitePage } from "../pages/invite";
import { NewTeamPage } from "../pages/new-team";
import { WorkspacePage } from "../pages/workspace";
import { NotFound, RouteError } from "./errors";
import { redirectIfSignedIn, requireSignedIn } from "./guards";
import { AppLayout, AuthLayout, FullPageSkeleton, InviteLayout, TeamLayout, RequireAdmin, RootLayout } from "./layouts";
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
            { path: "teams/new", Component: NewTeamPage },
            { path: "initiatives", Component: InitiativesPage },
            { path: "initiatives/:id", Component: InitiativePage },
            { path: "projects", Component: ProjectsPage },
            { path: "projects/:id", Component: ProjectPage },
            { path: "workspace", Component: WorkspacePage },
            { path: "agents", Component: AgentsPage },
            { path: "settings", Component: SettingsPage },
            {
              Component: RequireAdmin,
              children: [
                { path: "admin/workspaces", Component: AdminWorkspacesPage },
                { path: "admin/workspaces/:id", Component: AdminWorkspacePage },
                { path: "admin/invites", Component: AdminInvitesPage },
              ],
            },
            {
              path: "t/:key",
              Component: TeamLayout,
              children: [
                { index: true, Component: BoardPage },
                { path: "overview", Component: TeamOverviewPage },
                { path: "activity", Component: ActivityPage },
                { path: "map", Component: MapPage },
                { path: "docs", Component: DocsPage },
                { path: "docs/:docId", Component: DocsPage },
                { path: "decisions", Component: DecisionsPage },
                { path: "decisions/:number", Component: DecisionsPage },
                { path: "glossary", Component: GlossaryPage },
                { path: "glossary/:termId", Component: GlossaryPage },
                { path: "cycles", Component: CyclesPage },
                { path: "cycles/:number", Component: CyclePage },
                { path: "repos", Component: ReposPage },
                { path: "members", Component: TeamMembersPage },
                { path: "settings", Component: TeamSettingsPage },
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
