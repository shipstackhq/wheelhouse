/** The GitHub App's settings. Every one comes from the environment; with none set, the integration is simply off. */
export type GithubConfig = {
  appId: string;
  slug: string;
  privateKey: string;
  webhookSecret: string;
  clientId: string;
  clientSecret: string;
  apiUrl: string;
  webUrl: string;
};

/** PEM keys are often stored in one line with literal "\n"; accept both. */
const pem = (v: string) => v.replace(/\\n/g, "\n").trim();

export function githubConfig(env: Record<string, string | undefined> = process.env): GithubConfig | null {
  const c = {
    appId: env.GITHUB_APP_ID?.trim() ?? "",
    slug: env.GITHUB_APP_SLUG?.trim() ?? "",
    privateKey: env.GITHUB_APP_PRIVATE_KEY ? pem(env.GITHUB_APP_PRIVATE_KEY) : "",
    webhookSecret: env.GITHUB_WEBHOOK_SECRET ?? "",
    clientId: env.GITHUB_CLIENT_ID?.trim() ?? "",
    clientSecret: env.GITHUB_CLIENT_SECRET ?? "",
    // Overridable so tests and self-hosted GitHub Enterprise can point somewhere else.
    apiUrl: (env.GITHUB_API_URL?.trim() || "https://api.github.com").replace(/\/+$/, ""),
    webUrl: (env.GITHUB_WEB_URL?.trim() || "https://github.com").replace(/\/+$/, ""),
  };
  return c.appId && c.slug && c.privateKey && c.webhookSecret && c.clientId && c.clientSecret ? c : null;
}

/** What is missing, for an owner who is setting it up. */
export function githubMissing(env: Record<string, string | undefined> = process.env): string[] {
  const need: [string, string | undefined][] = [
    ["GITHUB_APP_ID", env.GITHUB_APP_ID],
    ["GITHUB_APP_SLUG", env.GITHUB_APP_SLUG],
    ["GITHUB_APP_PRIVATE_KEY", env.GITHUB_APP_PRIVATE_KEY],
    ["GITHUB_WEBHOOK_SECRET", env.GITHUB_WEBHOOK_SECRET],
    ["GITHUB_CLIENT_ID", env.GITHUB_CLIENT_ID],
    ["GITHUB_CLIENT_SECRET", env.GITHUB_CLIENT_SECRET],
  ];
  return need.filter(([, v]) => !v?.trim()).map(([k]) => k);
}
