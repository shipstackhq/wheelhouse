/** What the seed creates and the tests rely on. Written as JSON by seed.ts, read by every test file. */

export type WorkspaceFixture = {
  workspaceId: string;
  userId: string;
  email: string;
  memberEmail: string;
  teamKey: string;
  /** An issue tests may freely edit and move. */
  issueRef: string;
  /** An issue only the webhook tests touch (PR moves are blocked for ten minutes after someone else moves an issue). */
  webhookIssueRef: string;
  apiKey: string;
  apiKey2: string;
  revokedKey: string;
  /** Cookie value for `wh_session`; the database holds only its sha256. */
  sessionToken: string;
  expiredSessionToken: string;
  /** A member (not an owner) of the same workspace. */
  memberSessionToken: string;
};

export type GithubFixture = {
  appSlug: string;
  webhookSecret: string;
  clientSecret: string;
  /** Where the fake GitHub listens; the server under test must be configured with these. */
  apiUrl: string;
  webUrl: string;
  /** Installation + repository connected for workspace A (team A) and, with the SAME repository id, for workspace B. */
  installationA: string;
  installationB: string;
  repoId: string;
  /** An installation id the OAuth code "good" proves ownership of, and that no workspace has connected yet. */
  connectInstallationId: string;
  /** An installation connected to the "connect" workspace (and a repository only it can see), for tests that connect a repository. */
  installationC: string;
  connectRepoId: string;
};

export type Fixtures = {
  a: WorkspaceFixture;
  b: WorkspaceFixture;
  /** The password every seeded user signs in with. */
  password: string;
  suspended: { apiKey: string; sessionToken: string; email: string };
  /** An instance admin (the server under test lists this address in ADMIN_EMAILS), owner of a workspace of their own. */
  admin: { email: string; userId: string; workspaceId: string };
  /** A workspace that owns nothing yet: tests that connect GitHub repositories do it here so the seeded workspaces stay as they are. Has an owner and a member. */
  connect: { email: string; memberEmail: string; workspaceId: string };
  /** null when the server under test has no GitHub App configured. */
  github: GithubFixture | null;
  /** Environment the server under test needs (database location and GitHub settings). */
  serverEnv: Record<string, string>;
};
