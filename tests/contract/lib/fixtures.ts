/** What the seed creates and the tests rely on. Written as JSON by seed.ts, read by every test file. */

export type TeamFixture = {
  teamId: string;
  userId: string;
  email: string;
  memberEmail: string;
  projectKey: string;
  /** A ticket tests may freely edit and move. */
  ticketRef: string;
  /** A ticket only the webhook tests touch (PR moves are blocked for ten minutes after someone else moves a ticket). */
  webhookTicketRef: string;
  apiKey: string;
  apiKey2: string;
  revokedKey: string;
  /** Cookie value for `wh_session`; the database holds only its sha256. */
  sessionToken: string;
  expiredSessionToken: string;
  /** A member (not an owner) of the same team. */
  memberSessionToken: string;
};

export type GithubFixture = {
  appSlug: string;
  webhookSecret: string;
  clientSecret: string;
  /** Where the fake GitHub listens; the server under test must be configured with these. */
  apiUrl: string;
  webUrl: string;
  /** Installation + repository connected for team A (project A) and, with the SAME repository id, for team B. */
  installationA: string;
  installationB: string;
  repoId: string;
  /** An installation id the OAuth code "good" proves ownership of, and that no team has connected yet. */
  connectInstallationId: string;
};

export type Fixtures = {
  a: TeamFixture;
  b: TeamFixture;
  /** The password every seeded user signs in with. */
  password: string;
  suspended: { apiKey: string; sessionToken: string; email: string };
  /** An instance admin (the server under test lists this address in ADMIN_EMAILS), owner of a team of their own. */
  admin: { email: string; userId: string; teamId: string };
  /** null when the server under test has no GitHub App configured. */
  github: GithubFixture | null;
  /** Environment the server under test needs (database location and GitHub settings). */
  serverEnv: Record<string, string>;
};
