import { uuid, text, timestamp, integer, boolean, jsonb, primaryKey, index, uniqueIndex } from "drizzle-orm/pg-core";
import { table, createdAt, updatedAt } from "./common";
import { teamScope } from "./team-scope";
import { workspaces } from "./auth";
import { issues, projects } from "./issues";

/** Server's view of the default branch: content hash per file, updated when code lands. */
export const REPO_PROVIDERS = ["github", "local"] as const;

export const REPO_LIFECYCLES = ["live", "being_replaced", "planned", "retired"] as const;

/**
 * Multiple repositories per team (ADR-7, WH-68): a team can be served by
 * several repos (frontend/backend/admin…) or share a monorepo with other
 * teams. Each team<->repo link is its own row (so the same physical repo
 * connected to two teams is two rows, each with its own `pathLimit`), which
 * avoids a many-to-many join table and matches "each team's link to it
 * carries its own path limit" in the issue. `slug` is the natural
 * identifying key the CLI/wheelhouse.json reports for `provider: "local"`
 * (or the GitHub repo id once connected), used to find-or-create the right
 * row per team on each report.
 */
export const repositories = table(
  "repositories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    displayName: text("display_name").notNull(),
    role: text("role").notNull(), // free text: workspaces name their own roles (frontend/backend/admin/…)
    provider: text("provider", { enum: REPO_PROVIDERS }).notNull().default("local"),
    // Natural identifying key for "same physical repo": the slug/name the CLI reports (provider=local),
    // or the stringified GitHub repo id once connected (provider=github). Unique per team so
    // find-or-create resolves to exactly one row.
    slug: text("slug").notNull(),
    githubRepoId: text("github_repo_id"),
    githubInstallationId: text("github_installation_id"),
    githubFullName: text("github_full_name"), // "owner/name", for display; the id is what identifies the repository
    defaultBranch: text("default_branch").notNull().default("main"),
    // A monorepo directory this team's link is limited to, e.g. "packages/billing/". Null = whole repo.
    pathLimit: text("path_limit"),
    lifecycle: text("lifecycle", { enum: REPO_LIFECYCLES }).notNull().default("live"),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [teamScope("repositories", t), index("repositories_team_idx").on(t.teamId), uniqueIndex("repositories_team_slug_idx").on(t.teamId, t.slug)],
);

export const teamFiles = table(
  "team_files",
  {
    teamId: uuid("team_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    path: text("path").notNull(),
    hash: text("hash").notNull(),
    sha: text("sha"),
    // Which repository this file belongs to (WH-68). Null for existing single-repo rows written before this
    // change, or when the client doesn't report a repository — treated as "unqualified / matches everything".
    repositoryId: uuid("repository_id").references(() => repositories.id, { onDelete: "cascade" }),
    updatedAt: updatedAt(),
  },
  (t) => [teamScope("team_files", t), primaryKey({ columns: [t.teamId, t.path] })],
);

/**
 * WH-129: where an issue's work happens, an ordered list of repositories each with the branch the work starts from (the work branch is
 * always generated). A repository appears once per issue. The service checks that the repository is a connected GitHub repository of
 * the issue's team or of a team in its project, and that the branch exists, before it writes here.
 */
export const issueTargets = table(
  "issue_targets",
  {
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
    baseBranch: text("base_branch").notNull(),
    position: integer("position").notNull(),
  },
  (t) => [primaryKey({ columns: [t.issueId, t.repositoryId] })],
);

/** WH-135: the repositories a project's work happens in, each with an optional branch its issues start from. The fallback for an issue's targets. */
export const projectRepositories = table(
  "project_repositories",
  {
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
    branch: text("branch"),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.repositoryId] })],
);

// Which workspaces an installation of the App serves: one row per link. A row exists only after the installing person proved, through
// GitHub's own sign-in, that they administer that installation (an installation id alone is a public number), so the proof is per link.
export const githubInstallations = table(
  "github_installations",
  {
    installationId: text("installation_id").notNull(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    accountLogin: text("account_login").notNull().default(""),
    accountType: text("account_type").notNull().default(""),
    connectedBy: uuid("connected_by"), // the user who connected it; no FK, people can leave
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.installationId, t.workspaceId] })],
);

// Deliveries we have already handled (GitHub retries), so a redelivery changes nothing.
export const githubDeliveries = table("github_deliveries", {
  id: text("id").primaryKey(), // X-GitHub-Delivery
  event: text("event").notNull(),
  receivedAt: createdAt(),
});

// A pull request seen on a connected repository, with the state of its checks.
export const pullRequests = table(
  "pull_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    author: text("author").notNull().default(""),
    headBranch: text("head_branch").notNull().default(""),
    headSha: text("head_sha").notNull().default(""),
    state: text("state", { enum: ["open", "closed", "merged"] }).notNull().default("open"),
    draft: boolean("draft").notNull().default(false),
    // The latest result per check name for headSha; cleared when a new commit arrives.
    checks: jsonb("checks").$type<Record<string, { status: string; conclusion: string | null; url?: string | null }>>().notNull().default({}),
    ciState: text("ci_state", { enum: ["success", "failure", "pending"] }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("pull_requests_repo_number_idx").on(t.repositoryId, t.number)],
);

export const pullRequestIssues = table(
  "pull_request_issues",
  {
    pullRequestId: uuid("pull_request_id").notNull().references(() => pullRequests.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.pullRequestId, t.issueId] }), index("pull_request_issues_issue_idx").on(t.issueId)],
);

// ───────── workspace documentation (WH-51) ─────────
//
// Markdown docs that live in Wheelhouse next to the board and map: runbooks,
// product notes, conventions, decisions in prose. A tree (parentId), optimistic
// locking like issues, soft delete with a 30-day purge. Agents read them over
// MCP/REST; writing requires a key with the "docs:write" capability or a human.
