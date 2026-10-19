import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { call, fx } from "./lib/http";

const gh = fx.github!;
const cookieOf = (r: { cookies: string[] }, name: string) => r.cookies.find((c) => c.startsWith(`${name}=`));
const valueOf = (setCookie: string) => setCookie.split(";")[0].split("=").slice(1).join("=");
const location = (r: { headers: Headers }) => r.headers.get("location") ?? "";

/** Start the flow as an owner of workspace `t` and return what GitHub would get back to the callback. */
async function start(t: typeof fx.a) {
  const r = await call(`/api/github/install?team=${t.teamKey}`, { cookie: t.sessionToken });
  const state = new URL(location(r)).searchParams.get("state")!;
  const nonce = valueOf(cookieOf(r, "wh_gh_state")!);
  return { r, state, nonce };
}
const callback = (t: typeof fx.a, q: Record<string, string>, nonce: string | null) =>
  call(`/api/github/callback?${new URLSearchParams(q)}`, { cookie: t.sessionToken, extraCookies: nonce ? [`wh_gh_state=${nonce}`] : [] });

describe("GET /api/github/install", () => {
  test("signed out: sent to the login page", async () => {
    const r = await call(`/api/github/install?team=${fx.a.teamKey}`);
    assert.ok(r.status >= 300 && r.status < 400);
    assert.equal(new URL(location(r), "http://x").pathname, "/login");
  });

  test("an owner is sent to GitHub's install page with a signed state, and gets the state cookie", async () => {
    const { r, state, nonce } = await start(fx.a);
    assert.equal(r.status, 307);
    const to = new URL(location(r));
    // The address the server was told to send people to. Where the server runs in a container it reaches the fake GitHub by another
    // name than this process does (deploy/contract-in-docker.sh sets CONTRACT_GITHUB_WEB_URL to it).
    assert.equal(`${to.origin}${to.pathname}`, `${process.env.CONTRACT_GITHUB_WEB_URL ?? gh.webUrl}/apps/${gh.appSlug}/installations/new`);
    assert.ok(state.includes("."), "state is body.signature");
    assert.ok(nonce.length >= 16);
    const set = cookieOf(r, "wh_gh_state")!;
    assert.match(set, /HttpOnly/i);
    assert.match(set, /SameSite=lax/i);
    assert.match(set, /Path=\/api\/github/i);
    assert.match(set, /Max-Age=600/i);
    if (process.env.CONTRACT_EXPECT_SECURE === "1") assert.match(set, /Secure/i);
  });

  test("a member who is not an owner is sent back with owner_only", async () => {
    const r = await call(`/api/github/install?team=${fx.a.teamKey}`, { cookie: fx.a.memberSessionToken });
    assert.equal(r.status, 307);
    assert.equal(new URL(location(r), "http://x").searchParams.get("github_error"), "owner_only");
    assert.equal(new URL(location(r), "http://x").pathname, `/t/${fx.a.teamKey}/repos`);
  });

  test("another workspace's team is a plain 404", async () => {
    const r = await call(`/api/github/install?team=${fx.b.teamKey}`, { cookie: fx.a.sessionToken });
    assert.equal(r.status, 404);
  });
});

describe("GET /api/github/callback", () => {
  test("a bad, missing or foreign state is refused with a 400", async () => {
    const a = await start(fx.a);
    assert.equal((await callback(fx.a, { state: "garbage", installation_id: gh.connectInstallationId, code: "good" }, a.nonce)).status, 400);
    assert.equal((await callback(fx.a, { installation_id: gh.connectInstallationId, code: "good" }, a.nonce)).status, 400);
    // The right state without the browser's cookie is also refused: the link cannot be replayed from another browser.
    assert.equal((await callback(fx.a, { state: a.state, installation_id: gh.connectInstallationId, code: "good" }, null)).status, 400);
    // State minted for workspace A's owner, presented by workspace B's owner.
    const fromB = await callback(fx.b, { state: a.state, installation_id: gh.connectInstallationId, code: "good" }, a.nonce);
    assert.equal(fromB.status, 400);
  });

  test("an installation the person cannot administer is refused (not_yours); an unknown code fails", async () => {
    const a = await start(fx.a);
    const stranger = await callback(fx.a, { state: a.state, installation_id: gh.connectInstallationId, code: "stranger" }, a.nonce);
    assert.equal(stranger.status, 307);
    assert.equal(new URL(location(stranger), "http://x").searchParams.get("github_error"), "not_yours");
    const b = await start(fx.a);
    const bad = await callback(fx.a, { state: b.state, installation_id: gh.connectInstallationId, code: "nonsense" }, b.nonce);
    assert.equal(new URL(location(bad), "http://x").searchParams.get("github_error"), "failed");
    const c = await start(fx.a);
    const noCode = await callback(fx.a, { state: c.state, installation_id: gh.connectInstallationId }, c.nonce);
    assert.equal(new URL(location(noCode), "http://x").searchParams.get("github_error"), "no_code");
    const d = await start(fx.a);
    const badId = await callback(fx.a, { state: d.state, installation_id: "12abc", code: "good" }, d.nonce);
    assert.equal(new URL(location(badId), "http://x").searchParams.get("github_error"), "bad_installation");
  });

  test("the happy path connects the installation, clears the state cookie, and a replay is refused", async () => {
    const s = await start(fx.a);
    const r = await callback(fx.a, { state: s.state, installation_id: gh.connectInstallationId, code: "good" }, s.nonce);
    assert.equal(r.status, 307);
    const to = new URL(location(r), "http://x");
    assert.equal(to.pathname, `/t/${fx.a.teamKey}/repos`);
    assert.equal(to.searchParams.get("github"), "connected");
    const cleared = cookieOf(r, "wh_gh_state");
    assert.ok(cleared && /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(cleared), "the state cookie is deleted");
    const replay = await callback(fx.a, { state: s.state, installation_id: gh.connectInstallationId, code: "good" }, null);
    assert.equal(replay.status, 400);
  });

  test("an installation another workspace already holds cannot be taken over", async () => {
    const s = await start(fx.b);
    const r = await callback(fx.b, { state: s.state, installation_id: gh.connectInstallationId, code: "good" }, s.nonce);
    assert.equal(new URL(location(r), "http://x").searchParams.get("github_error"), "taken");
  });

  test("a member who is not an owner cannot finish a connection", async () => {
    const s = await start(fx.a);
    // The state belongs to the owner, so a member presenting it is refused at the state check.
    const r = await call(`/api/github/callback?${new URLSearchParams({ state: s.state, installation_id: gh.connectInstallationId, code: "good" })}`, { cookie: fx.a.memberSessionToken, extraCookies: [`wh_gh_state=${s.nonce}`] });
    assert.equal(r.status, 400);
  });
});
