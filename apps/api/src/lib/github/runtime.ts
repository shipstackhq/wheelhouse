import { githubConfig, type GithubConfig } from "./config";
import { GithubApi } from "./api";

// One client per process, so installation tokens are reused between deliveries.
const g = globalThis as unknown as { __wheelhouseGithub?: { cfg: GithubConfig; api: GithubApi } };

export function github(): { cfg: GithubConfig; api: GithubApi } | null {
  const cfg = githubConfig();
  if (!cfg) return null;
  if (!g.__wheelhouseGithub || g.__wheelhouseGithub.cfg.appId !== cfg.appId || g.__wheelhouseGithub.cfg.apiUrl !== cfg.apiUrl) g.__wheelhouseGithub = { cfg, api: new GithubApi(cfg) };
  return g.__wheelhouseGithub;
}
