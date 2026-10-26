import { describe, test } from "node:test";
import assert from "node:assert/strict";
// The typed client is a shared package, not the app: this is the one place the suite imports it, to prove it works over real HTTP.
import { ApiError, createApiClient } from "../../packages/api-client/src/index";
import { BASE, fx } from "./lib/http";
import { app, browserFetch, newEmail, signIn } from "./lib/app";

const client = () => createApiClient({ baseUrl: BASE, fetch: browserFetch() });
const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof ApiError, `expected an ApiError, got ${e}`);
    return e;
  }
  return assert.fail("expected the call to fail");
};

describe("@wheelhouse/api-client against the real API", () => {
  test("signed out: me() is null and sign-up is on offer", async () => {
    const api = client();
    assert.equal(await api.me(), null);
    assert.deepEqual(await api.auth.options(), { signupOpen: true });
  });

  test("a wrong password is an ApiError with the stable code, and nothing is signed in", async () => {
    const api = client();
    const e = await failure(api.auth.login({ email: fx.a.email, password: "nope" }));
    assert.equal(e.status, 401);
    assert.equal(e.code, "unauthorized");
    assert.equal(e.message, "Invalid email or password");
    assert.equal(await api.me(), null);
  });

  test("sign in, read, sign out", async () => {
    const api = client();
    const me = await api.auth.login({ email: fx.a.email, password: fx.password });
    assert.equal(me.workspace.id, fx.a.workspaceId);
    assert.equal((await api.me())?.user.email, fx.a.email);
    assert.deepEqual((await api.teams.list()).map((p) => p.key), [fx.a.teamKey]);
    await api.auth.logout();
    assert.equal(await api.me(), null);
    await failure(api.teams.list()).then((e) => assert.ok(e.isSignedOut));
  });

  test("sign-up problems arrive by field", async () => {
    const e = await failure(client().auth.signup({ name: "", email: "x", password: "short" }));
    assert.equal(e.code, "invalid");
    assert.deepEqual(Object.keys(e.fields!).sort(), ["email", "name"]);
    const weak = await failure(client().auth.signup({ name: "Ok", email: newEmail(), password: "short" }));
    assert.equal(weak.fields?.password, "Password must be at least 12 characters");
  });

  test("sign-up signs the new person in", async () => {
    const api = client();
    const me = await api.auth.signup({ name: "Client Kim", email: newEmail(), password: "a-long-enough-password" });
    assert.equal(me.workspace.name, "Client Kim");
    assert.deepEqual(await api.teams.list(), []);
    await api.auth.logout();
  });

  test("a token gone stale because the session changed underneath is refreshed and the call goes through", async () => {
    const jarFetch = browserFetch();
    const api = createApiClient({ baseUrl: BASE, fetch: jarFetch });
    await api.auth.login({ email: fx.a.email, password: fx.password });
    // Another tab signs in again: the cookie in the shared jar is replaced, so the client's cached token no longer matches.
    const other = createApiClient({ baseUrl: BASE, fetch: jarFetch });
    await other.auth.login({ email: fx.a.email, password: fx.password });
    await api.auth.logout(); // would be a 403 csrf_failed without the transparent refresh
    assert.equal(await api.me(), null);
  });

  test("a rate limit exposes how long to wait", async () => {
    const email = newEmail();
    const made = await client().auth.signup({ name: "Rate", email, password: "a-long-enough-password" });
    assert.ok(made.user.id);
    for (let i = 0; i < 8; i++) await failure(client().auth.login({ email, password: "wrong" }));
    const e = await failure(client().auth.login({ email, password: "a-long-enough-password" }));
    assert.equal(e.code, "rate_limited");
    assert.ok(e.retryAfter && e.retryAfter > 0);
    await signIn(fx.a.email).then((s) => app("POST", "/api/app/auth/logout", s));
  });
});
