import { Link, useLocation } from "react-router";
import clsx from "clsx";
import { ChevronRightIcon } from "./icons";

export type Crumb = { label: string; to?: string };

const TEAM_SECTIONS: Record<string, string> = {
  overview: "Overview",
  activity: "Activity",
  map: "Map",
  docs: "Docs",
  decisions: "Decisions",
  glossary: "Glossary",
  cycles: "Cycles",
  members: "Team members",
  settings: "Team settings",
  onboarding: "Onboarding",
};

/** What the item under a team section is called in the trail: its kind, since the header does not know the page's data. */
const TEAM_ITEM: Record<string, string> = {
  docs: "Document",
  decisions: "Decision",
  glossary: "Term",
  cycles: "Cycle",
};

const WORKSPACE_PAGES: Record<string, { label: string; item?: string }> = {
  initiatives: { label: "Initiatives", item: "Initiative" },
  projects: { label: "Projects", item: "Project" },
  workspace: { label: "Members" },
  agents: { label: "Agents & API keys" },
};

/**
 * The trail for an address: the workspace, then wherever you are inside it. Dummy labels for now: an item deeper than a section
 * (a document, a project) is named by its kind, since the header does not know the page's data.
 */
export function crumbsFor(pathname: string, workspaceName: string, teams: { key: string; name: string }[]): Crumb[] {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const root: Crumb = { label: workspaceName, to: "/" };
  if (parts.length === 0) return [root, { label: "Home" }];
  const [first, second, third] = parts;
  if (first === "t" && second) {
    const team = teams.find((t) => t.key === second);
    const teamCrumb: Crumb = { label: team?.name ?? second, to: `/t/${second}` };
    if (!third) return [root, { ...teamCrumb, to: undefined }, { label: "Issues" }];
    const section = TEAM_SECTIONS[third];
    if (!section) return [root, teamCrumb];
    const item = parts[3] ? TEAM_ITEM[third] : undefined;
    return item
      ? [root, teamCrumb, { label: section, to: `/t/${second}/${third}` }, { label: item }]
      : [root, teamCrumb, { label: section }];
  }
  if (first === "inbox") return [root, { label: "Inbox" }];
  if (first === "teams" && second === "new") return [root, { label: "Teams" }, { label: "New team" }];
  if (first === "admin") {
    const page = { workspaces: "Workspaces", invites: "Invite a new workspace" }[second ?? ""];
    const base: Crumb[] = [root, { label: "Admin", to: undefined }];
    if (!page) return base;
    return third ? [...base, { label: page, to: `/admin/${second}` }, { label: "Workspace" }] : [...base, { label: page }];
  }
  const page = WORKSPACE_PAGES[first];
  if (page) return second && page.item ? [root, { label: page.label, to: `/${first}` }, { label: page.item }] : [root, { label: page.label }];
  return [root];
}

/** The header's "you are here": every step but the last links back; the last is the page and is marked as such. */
export function Breadcrumbs({ workspaceName, teams }: { workspaceName: string; teams: { key: string; name: string }[] }) {
  const { pathname } = useLocation();
  const crumbs = crumbsFor(pathname, workspaceName, teams);
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <div className="flex min-w-0 items-center gap-1 text-xs">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <span key={i} className={clsx("flex min-w-0 items-center gap-1", !last && "shrink-0 max-md:hidden", last && "max-md:flex")}>
              {c.to && !last ? (
                <Link to={c.to} className="max-w-40 truncate rounded px-1 text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/50">
                  {c.label}
                </Link>
              ) : (
                <span aria-current={last ? "page" : undefined} className={clsx("truncate px-1", last ? "font-medium text-fg" : "max-w-40 text-muted")}>
                  {c.label}
                </span>
              )}
              {!last && <ChevronRightIcon aria-hidden className="shrink-0 text-base text-muted/60" />}
            </span>
          );
        })}
      </div>
    </nav>
  );
}
