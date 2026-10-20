import { describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { appJwt, GithubApi, GithubApiError, isZeroSha } from "./api";
import { githubConfig, githubMissing, type GithubConfig } from "./config";
import { roleFromText, type RoleColumn } from "../column-roles";
import { ciState, decideMove, RECENT_MOVE_MS } from "./pr-rules";
import { parseIssueRefs, refsForTeam } from "./refs";
import { signBody, verifySignature } from "./signature";
import { makeState, readState, STATE_TTL_MS } from "./state";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const cfg: GithubConfig = { appId: "123", slug: "wheelhouse-test", privateKey, webhookSecret: "whsec", clientId: "cid", clientSecret: "csecret", apiUrl: "https://api.example.test", webUrl: "https://gh.example.test" };

describe("webhook signatures", () => {
  const body = '{"zen":"Keep it logically awesome."}';
  test("the signature GitHub would send is accepted", () => {
    assert.equal(verifySignature("s3cret", body, signBody("s3cret", body)), true);
    assert.equal(verifySignature("s3cret", Buffer.from(body), signBody("s3cret", body)), true);
  });
  test("a wrong secret, a changed body, or a missing or malformed header is refused", () => {
    assert.equal(verifySignature("other", body, signBody("s3cret", body)), false);
    assert.equal(verifySignature("s3cret", body + " ", signBody("s3cret", body)), false);
    for (const bad of [null, undefined, "", "sha256=", "sha256=zz", "sha1=" + "a".repeat(40), "a".repeat(64), "sha256=" + "a".repeat(63), "sha256=" + "a".repeat(65), "SHA256=" + "a".repeat(64)]) {
      assert.equal(verifySignature("s3cret", body, bad as string), false, String(bad));
    }
    assert.equal(verifySignature("", body, signBody("", body)), false, "an unset secret never validates anything");
  });
});

describe("issue references", () => {
  test("found in titles and branch names, in any case, once each, in order", () => {
    assert.deepEqual(parseIssueRefs("WH-12 Add the thing", "feature/wh-12-add-thing"), [{ key: "WH", number: 12 }]);
    assert.deepEqual(parseIssueRefs("Fix WH-3 and WH-14 (see wh-3)"), [{ key: "WH", number: 3 }, { key: "WH", number: 14 }]);
    assert.deepEqual(parseIssueRefs("[WH-9] polish", "wh-9/polish"), [{ key: "WH", number: 9 }]);
  });
  test("things that only look like references are not", () => {
    assert.deepEqual(parseIssueRefs("Bump utf-8 handling", "v1-2", "ABCDEFG-1", "WH-0", "WH-", "-12", "x1WH-5", "WH-1234567"), [{ key: "UTF", number: 8 }], "only well-formed ones, still unresolved until a team key matches");
    assert.deepEqual(parseIssueRefs(null, undefined, ""), []);
  });
  test("only the team's own key counts, so a shared repository does not link another team's issues", () => {
    const refs = parseIssueRefs("WH-12 and API-7 and UTF-8");
    assert.deepEqual(refsForTeam(refs, "WH"), [{ key: "WH", number: 12 }]);
    assert.deepEqual(refsForTeam(refs, "wh"), [{ key: "WH", number: 12 }]);
    assert.deepEqual(refsForTeam(refs, "API"), [{ key: "API", number: 7 }]);
  });
});

describe("what a pull request does to its issue", () => {
  // Columns carry a role (WH-86); the rules only ever look at roles. Standard names get their standard roles here.
  const cols = (...names: string[]): RoleColumn[] => names.map((name) => ({ name, role: roleFromText(name) }));
  const board = cols("Backlog", "Todo", "In Progress", "Review", "Done");
  const now = new Date("2026-10-15T12:00:00Z");
  const base = { merged: false, draft: false, columns: board, now, lastMove: null };
  const d = (over: Partial<Omit<Parameters<typeof decideMove>[0], "column">> & { action: string; column: string }) => {
    const columns = over.columns ?? board;
    return decideMove({ ...base, ...over, columns, column: columns.find((c) => c.name === over.column)! });
  };

  test("opened moves the issue to Review, from anywhere before it", () => {
    for (const column of ["Backlog", "Todo", "In Progress"]) assert.equal(d({ action: "opened", column }).move, "Review", column);
    assert.equal(d({ action: "reopened", column: "In Progress" }).move, "Review");
    assert.equal(d({ action: "ready_for_review", column: "In Progress" }).move, "Review");
  });
  test("a draft is left alone until it is ready, and an issue already in Review or Done is not touched", () => {
    assert.equal(d({ action: "opened", column: "In Progress", draft: true }).move, null);
    assert.equal(d({ action: "opened", column: "Review" }).move, null);
    assert.equal(d({ action: "opened", column: "Done" }).move, null);
  });
  test("merged leaves an issue in Review for a person, and only pulls an earlier one forward", () => {
    assert.equal(d({ action: "closed", merged: true, column: "Review" }).move, null);
    assert.equal(d({ action: "closed", merged: true, column: "Done" }).move, null);
    assert.equal(d({ action: "closed", merged: true, column: "In Progress" }).move, "Review");
    assert.equal(d({ action: "closed", merged: true, column: "Todo" }).move, "Review");
  });
  test("closed without merging goes back to In Progress, but only from Review", () => {
    assert.equal(d({ action: "closed", column: "Review" }).move, "In Progress");
    for (const column of ["Backlog", "Todo", "In Progress", "Done"]) assert.equal(d({ action: "closed", column }).move, null, column);
  });
  test("pushes, edits and everything else never move an issue", () => {
    for (const action of ["synchronize", "edited", "labeled", "assigned", "converted_to_draft"]) assert.equal(d({ action, column: "In Progress" }).move, null, action);
  });
  test("someone moved it a moment ago: leave it, and say why", () => {
    const r = d({ action: "opened", column: "In Progress", lastMove: { at: new Date(now.getTime() - 3 * 60_000), by: "Claude Atharva's Macbook Pro" } });
    assert.equal(r.move, null);
    assert.match(r.note!, /Claude Atharva's Macbook Pro moved it 3 minutes ago/);
    assert.match(r.note!, /did not move it/);
  });
  test("an older move does not get in the way, and the window can be changed", () => {
    const old = { at: new Date(now.getTime() - RECENT_MOVE_MS - 1000), by: "Demo" };
    assert.equal(d({ action: "opened", column: "In Progress", lastMove: old }).move, "Review");
    assert.equal(d({ action: "opened", column: "In Progress", lastMove: old, recentMs: 60 * 60_000 }).move, null);
  });
  test("a board without a Review column is left alone instead of guessed at", () => {
    assert.equal(d({ action: "opened", column: "Todo", columns: cols("Todo", "Doing", "Done") }).move, null);
  });
  test("columns are found by role, so renaming them changes nothing", () => {
    const renamed: RoleColumn[] = [
      { name: "Ideas", role: "backlog" },
      { name: "Ready", role: "todo" },
      { name: "Doing", role: "in_progress" },
      { name: "QA", role: "review" },
      { name: "Shipped", role: "done" },
    ];
    assert.equal(d({ action: "opened", column: "Doing", columns: renamed }).move, "QA");
    assert.equal(d({ action: "closed", column: "QA", columns: renamed }).move, "Doing");
    assert.equal(d({ action: "closed", merged: true, column: "Ready", columns: renamed }).move, "QA");
    assert.equal(d({ action: "closed", merged: true, column: "QA", columns: renamed }).move, null);
    assert.equal(d({ action: "opened", column: "Shipped", columns: renamed }).move, null);
    assert.match(d({ action: "opened", column: "Doing", columns: renamed }).note!, /moved to QA: pull request opened/);
  });
  test("a column literally named Review but with no role is not treated as the review column", () => {
    const odd: RoleColumn[] = [{ name: "Todo", role: "todo" }, { name: "Review", role: null }, { name: "Done", role: "done" }];
    assert.equal(d({ action: "opened", column: "Todo", columns: odd }).move, null);
    assert.equal(d({ action: "closed", column: "Review", columns: odd }).move, null);
  });
  test("a custom column with no role is outside the workflow: never a target, and an issue in one is left where a person put it", () => {
    const custom: RoleColumn[] = [{ name: "Todo", role: "todo" }, { name: "Blocked", role: null }, { name: "Doing", role: "in_progress" }, { name: "Review", role: "review" }, { name: "Done", role: "done" }];
    for (const action of ["opened", "reopened", "ready_for_review", "closed"]) {
      assert.equal(d({ action, column: "Blocked", columns: custom }).move, null, action);
      assert.equal(d({ action, merged: action === "closed", column: "Blocked", columns: custom }).move, null, `${action} merged`);
    }
    assert.equal(d({ action: "opened", column: "Doing", columns: custom }).move, "Review", "custom columns between the standard ones do not get in the way");
    assert.equal(d({ action: "closed", column: "Review", columns: custom }).move, "Doing");
  });
  test("two columns with the review role: the first in board order is the target", () => {
    const two: RoleColumn[] = [{ name: "Doing", role: "in_progress" }, { name: "Code review", role: "review" }, { name: "Design review", role: "review" }, { name: "Done", role: "done" }];
    assert.equal(d({ action: "opened", column: "Doing", columns: two }).move, "Code review");
    assert.equal(d({ action: "opened", column: "Design review", columns: two }).move, null, "already in a review column");
  });
  test("the note explains a move", () => {
    assert.match(d({ action: "opened", column: "Todo" }).note!, /moved to Review: pull request opened/);
    assert.match(d({ action: "closed", column: "Review" }).note!, /moved to In Progress: pull request closed without merging/);
  });
});

describe("combining checks", () => {
  const c = (status: string, conclusion: string | null) => ({ status, conclusion });
  test("no checks: no state; any failure wins; running beats success", () => {
    assert.equal(ciState({}), null);
    assert.equal(ciState({ a: c("completed", "success"), b: c("completed", "failure") }), "failure");
    assert.equal(ciState({ a: c("in_progress", null), b: c("completed", "failure") }), "failure");
    assert.equal(ciState({ a: c("in_progress", null), b: c("completed", "success") }), "pending");
    assert.equal(ciState({ a: c("queued", null) }), "pending");
    assert.equal(ciState({ a: c("completed", "success"), b: c("completed", "skipped"), d: c("completed", "neutral") }), "success");
    for (const bad of ["timed_out", "cancelled", "action_required"]) assert.equal(ciState({ a: c("completed", bad) }), "failure", bad);
  });
});

describe("the signed connect link", () => {
  const t0 = 1_800_000_000_000;
  test("a fresh link comes back as it was made", () => {
    const { state, nonce } = makeState("k", { user: "u1", team: "WH" }, t0);
    assert.deepEqual(readState("k", state, t0 + 1000), { user: "u1", team: "WH", nonce, exp: t0 + STATE_TTL_MS });
  });
  test("a link that expired, was tampered with, was signed with another key, or is garbage is refused", () => {
    const { state } = makeState("k", { user: "u1", team: "WH" }, t0);
    assert.equal(readState("k", state, t0 + STATE_TTL_MS + 1), null, "expired");
    assert.equal(readState("other", state, t0 + 1), null, "another key");
    const [body, sig] = state.split(".");
    const forged = Buffer.from(JSON.stringify({ user: "attacker", team: "WH", nonce: "x", exp: t0 + 99999999 })).toString("base64url");
    assert.equal(readState("k", `${forged}.${sig}`, t0 + 1), null, "body changed");
    assert.equal(readState("k", `${body}.${sig.slice(0, -2)}xx`, t0 + 1), null, "signature changed");
    for (const junk of [null, undefined, "", "abc", "a.b", "a.b.c", "."]) assert.equal(readState("k", junk as string, t0), null, String(junk));
  });
  test("every link has its own nonce", () => {
    assert.notEqual(makeState("k", { user: "u", team: "WH" }, t0).nonce, makeState("k", { user: "u", team: "WH" }, t0).nonce);
  });
});

describe("GitHub App settings", () => {
  const env = { GITHUB_APP_ID: "1", GITHUB_APP_SLUG: "wh", GITHUB_APP_PRIVATE_KEY: "-----BEGIN KEY-----\\nabc\\n-----END KEY-----", GITHUB_WEBHOOK_SECRET: "s", GITHUB_CLIENT_ID: "c", GITHUB_CLIENT_SECRET: "x" };
  test("all six settings turn it on, and a key written on one line is repaired", () => {
    const c = githubConfig(env)!;
    assert.ok(c);
    assert.equal(c.privateKey, "-----BEGIN KEY-----\nabc\n-----END KEY-----");
    assert.equal(c.apiUrl, "https://api.github.com");
  });
  test("with any missing it is off, and the missing ones are named", () => {
    assert.equal(githubConfig({ ...env, GITHUB_CLIENT_SECRET: "" }), null);
    assert.deepEqual(githubMissing({ ...env, GITHUB_CLIENT_SECRET: "", GITHUB_WEBHOOK_SECRET: " " }), ["GITHUB_WEBHOOK_SECRET", "GITHUB_CLIENT_SECRET"]);
    assert.deepEqual(githubMissing({}).length, 6);
  });
});

describe("talking to GitHub", () => {
  test("the App's token is a real RS256 JWT for this app that expires in minutes", () => {
    const now = 1_800_000_000_000;
    const jwt = appJwt(cfg, now);
    const [h, b, s] = jwt.split(".");
    assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { alg: "RS256", typ: "JWT" });
    const body = JSON.parse(Buffer.from(b, "base64url").toString());
    assert.equal(body.iss, "123");
    assert.ok(body.exp - body.iat <= 10 * 60, "GitHub allows at most ten minutes");
    assert.ok(body.iat < now / 1000, "backdated for clock drift");
    assert.equal(crypto.createVerify("RSA-SHA256").update(`${h}.${b}`).verify(publicKey, Buffer.from(s, "base64url")), true);
  });

  /** A fake GitHub: records calls, answers from a table. */
  function fake(routes: Record<string, (url: URL, init?: RequestInit) => unknown>) {
    const calls: { method: string; path: string; auth: string | null }[] = [];
    const doFetch = async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      calls.push({ method: init?.method ?? "GET", path: u.pathname + u.search, auth: new Headers(init?.headers).get("authorization") });
      const key = `${init?.method ?? "GET"} ${u.pathname}`;
      const h = routes[key];
      if (!h) return new Response("{}", { status: 404 });
      const out = h(u, init);
      return out instanceof Response ? out : Response.json(out);
    };
    return { calls, doFetch };
  }
  const tokenRoute = { "POST /app/installations/7/access_tokens": () => ({ token: "ghs_tok", expires_at: new Date(Date.now() + 3600_000).toISOString() }) };

  test("an installation token is fetched with the App's JWT and then reused", async () => {
    const f = fake({ ...tokenRoute, "GET /installation/repositories": () => ({ repositories: [{ id: 1, full_name: "o/a", default_branch: "main", private: false }] }) });
    const api = new GithubApi({ ...cfg, apiUrl: "https://api.example.test" }, f.doFetch);
    await api.installationRepositories("7");
    await api.installationRepositories("7");
    assert.equal(f.calls.filter((c) => c.path.includes("access_tokens")).length, 1, "one token for two calls");
    assert.match(f.calls[0].auth!, /^Bearer eyJ/, "the first call proves we are the App");
    assert.equal(f.calls[1].auth, "Bearer ghs_tok", "later calls use the installation token");
  });

  test("a token about to expire is replaced", async () => {
    let n = 0;
    const f = fake({
      "POST /app/installations/7/access_tokens": () => ({ token: `t${++n}`, expires_at: new Date(Date.now() + 2 * 60_000).toISOString() }),
      "GET /installation/repositories": () => ({ repositories: [] }),
    });
    const api = new GithubApi(cfg, f.doFetch);
    await api.installationRepositories("7");
    await api.installationRepositories("7");
    assert.equal(n, 2);
  });

  test("changed files come back with blob hashes: added and modified keep theirs, removed ones are null, a rename removes the old path", async () => {
    const f = fake({
      ...tokenRoute,
      "GET /repositories/9/compare/aaa...bbb": () => ({
        files: [
          { filename: "src/a.ts", status: "modified", sha: "h1" },
          { filename: "src/new.ts", status: "added", sha: "h2" },
          { filename: "src/gone.ts", status: "removed", sha: "h3" },
          { filename: "src/after.ts", status: "renamed", sha: "h4", previous_filename: "src/before.ts" },
        ],
      }),
    });
    const files = await new GithubApi(cfg, f.doFetch).changedBetween("7", "9", "aaa", "bbb");
    assert.deepEqual(Object.fromEntries(files.map((x) => [x.path, x.hash])), { "src/a.ts": "h1", "src/new.ts": "h2", "src/gone.ts": null, "src/before.ts": null, "src/after.ts": "h4" });
  });

  test("a long list is read page by page until a short page", async () => {
    const page = (n: number, len: number) => ({ files: Array.from({ length: len }, (_, i) => ({ filename: `f${n}-${i}`, status: "modified", sha: `s${n}-${i}` })) });
    const f = fake({ ...tokenRoute, "GET /repositories/9/compare/a...b": (u) => (u.searchParams.get("page") === "1" ? page(1, 100) : u.searchParams.get("page") === "2" ? page(2, 100) : page(3, 5)) });
    const files = await new GithubApi(cfg, f.doFetch).changedBetween("7", "9", "a", "b");
    assert.equal(files.length, 205);
    assert.equal(f.calls.filter((c) => c.path.includes("compare")).length, 3);
  });

  test("a whole tree is only its files, and says when GitHub cut it short", async () => {
    const f = fake({ ...tokenRoute, "GET /repositories/9/git/trees/abc": () => ({ truncated: true, tree: [{ path: "a.ts", type: "blob", sha: "1" }, { path: "src", type: "tree", sha: "2" }, { path: "src/b.ts", type: "blob", sha: "3" }] }) });
    const r = await new GithubApi(cfg, f.doFetch).treeAt("7", "9", "abc");
    assert.deepEqual(r.files, [{ path: "a.ts", hash: "1" }, { path: "src/b.ts", hash: "3" }]);
    assert.equal(r.truncated, true);
  });

  test("an error from GitHub carries its status and never its body", async () => {
    const f = fake({ ...tokenRoute, "GET /repositories/9/compare/a...b": () => new Response(JSON.stringify({ message: "secret detail" }), { status: 404 }) });
    await assert.rejects(new GithubApi(cfg, f.doFetch).changedBetween("7", "9", "a", "b"), (e: unknown) => e instanceof GithubApiError && e.status === 404 && !e.message.includes("secret detail"));
  });

  test("a person's installations come from their own GitHub sign-in, not from anything they typed", async () => {
    const f = fake({
      "POST /login/oauth/access_token": (_u, init) => {
        assert.deepEqual(JSON.parse(String(init?.body)), { client_id: "cid", client_secret: "csecret", code: "the-code" });
        return { access_token: "user-token" };
      },
      "GET /user/installations": () => ({ installations: [{ id: 7 }, { id: 8 }] }),
    });
    const api = new GithubApi({ ...cfg, webUrl: "https://api.example.test" }, f.doFetch);
    assert.deepEqual(await api.userInstallationIds("the-code"), ["7", "8"]);
    assert.equal(f.calls.find((c) => c.path.startsWith("/user/installations"))!.auth, "Bearer user-token");
  });

  test("a sign-in code GitHub refuses is an error, not an empty list", async () => {
    const f = fake({ "POST /login/oauth/access_token": () => ({ error: "bad_verification_code" }) });
    await assert.rejects(new GithubApi({ ...cfg, webUrl: "https://api.example.test" }, f.doFetch).userInstallationIds("nope"), GithubApiError);
  });

  test("the all-zero commit GitHub uses for a new branch is recognised", () => {
    assert.equal(isZeroSha("0".repeat(40)), true);
    assert.equal(isZeroSha(null), true);
    assert.equal(isZeroSha("a".repeat(40)), false);
  });
});
