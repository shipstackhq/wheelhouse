import crypto from "node:crypto";
import type { GithubConfig } from "./config";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** The short-lived token that proves we are the App (RS256, valid 9 minutes, backdated a minute for clock drift). */
export function appJwt(cfg: Pick<GithubConfig, "appId" | "privateKey">, nowMs = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: cfg.appId }));
  const sig = crypto.createSign("RSA-SHA256").update(`${head}.${body}`).sign(cfg.privateKey);
  return `${head}.${body}.${b64url(sig)}`;
}

export class GithubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type ChangedFile = { path: string; /** blob sha of the new content, null when the file is gone */ hash: string | null };

const ZERO_SHA = /^0{40}$/;
export const isZeroSha = (s: string | null | undefined) => !s || ZERO_SHA.test(s);

/**
 * The little of GitHub's API we use: changed files and their blob hashes (never contents), an installation's
 * repositories, who may use an installation, and opening a pull request for a daemon's branch. The HTTP client is
 * injected so every call can be tested.
 */
export class GithubApi {
  private tokens = new Map<string, { token: string; expires: number }>();

  constructor(
    private cfg: GithubConfig,
    private doFetch: Fetch = fetch,
    private now: () => number = Date.now,
  ) {}

  private async call<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
    const res = await this.doFetch(`${this.cfg.apiUrl}${path}`, {
      ...init,
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "wheelhouse", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
    if (!res.ok) throw new GithubApiError(`GitHub ${init.method ?? "GET"} ${path.split("?")[0]} answered ${res.status}`, res.status);
    return (await res.json()) as T;
  }

  /** A token for one installation, cached until a few minutes before it expires. */
  async installationToken(installationId: string): Promise<string> {
    const hit = this.tokens.get(installationId);
    if (hit && hit.expires - this.now() > 5 * 60_000) return hit.token;
    const r = await this.call<{ token: string; expires_at: string }>(`/app/installations/${encodeURIComponent(installationId)}/access_tokens`, appJwt(this.cfg, this.now()), { method: "POST" });
    this.tokens.set(installationId, { token: r.token, expires: new Date(r.expires_at).getTime() });
    return r.token;
  }

  /** Files changed between two commits, 100 a page. GitHub lists at most 3000. */
  async changedBetween(installationId: string, repoId: string, base: string, head: string): Promise<ChangedFile[]> {
    const token = await this.installationToken(installationId);
    const out = new Map<string, string | null>();
    for (let page = 1; page <= 30; page++) {
      const r = await this.call<{ files?: { filename: string; status: string; sha: string | null; previous_filename?: string }[] }>(
        `/repositories/${encodeURIComponent(repoId)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=100&page=${page}`,
        token,
      );
      const files = r.files ?? [];
      for (const f of files) {
        if (f.status === "renamed" && f.previous_filename) out.set(f.previous_filename, null);
        out.set(f.filename, f.status === "removed" ? null : f.sha);
      }
      if (files.length < 100) break;
    }
    return [...out].map(([path, hash]) => ({ path, hash }));
  }

  /** Every file at a commit (for a first push or one whose base no longer exists). Blobs only. */
  async treeAt(installationId: string, repoId: string, sha: string): Promise<{ files: ChangedFile[]; truncated: boolean }> {
    const token = await this.installationToken(installationId);
    const r = await this.call<{ tree: { path: string; type: string; sha: string }[]; truncated?: boolean }>(`/repositories/${encodeURIComponent(repoId)}/git/trees/${encodeURIComponent(sha)}?recursive=1`, token);
    return { files: r.tree.filter((t) => t.type === "blob").map((t) => ({ path: t.path, hash: t.sha })), truncated: !!r.truncated };
  }

  /** A repository's branch names, 100 a page, at most 1,000. */
  async branches(installationId: string, repoId: string): Promise<string[]> {
    const token = await this.installationToken(installationId);
    const out: string[] = [];
    for (let page = 1; page <= 10; page++) {
      const r = await this.call<{ name: string }[]>(`/repositories/${encodeURIComponent(repoId)}/branches?per_page=100&page=${page}`, token);
      out.push(...r.map((b) => b.name));
      if (r.length < 100) break;
    }
    return out;
  }

  /** The repositories an installation can see. */
  async installationRepositories(installationId: string): Promise<{ id: string; fullName: string; defaultBranch: string; private: boolean }[]> {
    const token = await this.installationToken(installationId);
    const out: { id: string; fullName: string; defaultBranch: string; private: boolean }[] = [];
    for (let page = 1; page <= 20; page++) {
      const r = await this.call<{ repositories: { id: number; full_name: string; default_branch: string; private: boolean }[] }>(`/installation/repositories?per_page=100&page=${page}`, token);
      out.push(...r.repositories.map((x) => ({ id: String(x.id), fullName: x.full_name, defaultBranch: x.default_branch, private: x.private })));
      if (r.repositories.length < 100) break;
    }
    return out;
  }

  /** Open a pull request from `head` into `base`, as the App (it shows as `<slug>[bot]`). Needs "Pull requests: Read and write". */
  async openPullRequest(installationId: string, repoId: string, pr: { title: string; head: string; base: string; body: string; draft?: boolean }): Promise<{ number: number; url: string }> {
    const token = await this.installationToken(installationId);
    const r = await this.call<{ number: number; html_url: string }>(`/repositories/${encodeURIComponent(repoId)}/pulls`, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: pr.title, head: pr.head, base: pr.base, body: pr.body, draft: pr.draft ?? false }),
    });
    return { number: r.number, url: r.html_url };
  }

  /** The installation's account (who owns it), for display. */
  async installationAccount(installationId: string): Promise<{ login: string; type: string }> {
    const r = await this.call<{ account?: { login: string; type: string } }>(`/app/installations/${encodeURIComponent(installationId)}`, appJwt(this.cfg, this.now()));
    return { login: r.account?.login ?? "unknown", type: r.account?.type ?? "unknown" };
  }

  /**
   * Trade the `code` GitHub sends back after installation for the installing person's own token, then ask what *they* can
   * administer. This is what stops a user from claiming an installation (a public number) that is not theirs.
   */
  async userInstallationIds(code: string): Promise<string[]> {
    const res = await this.doFetch(`${this.cfg.webUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "wheelhouse" },
      body: JSON.stringify({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, code }),
    });
    const t = (await res.json().catch(() => ({}))) as { access_token?: string };
    if (!res.ok || !t.access_token) throw new GithubApiError("GitHub did not accept the sign-in code", 401);
    const ids: string[] = [];
    for (let page = 1; page <= 20; page++) {
      const r = await this.call<{ installations: { id: number }[] }>(`/user/installations?per_page=100&page=${page}`, t.access_token);
      ids.push(...r.installations.map((i) => String(i.id)));
      if (r.installations.length < 100) break;
    }
    return ids;
  }
}
