import { describe, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { ApiError } from "@wheelhouse/api-client";
import { ADA, renderApp, signedOut } from "../test/harness";
import { FakeEventSource } from "../test/fake-event-source";

/** The pages ported so far (WH-95, WH-96), by address, with something only that page shows. The addresses are the Next app's, unchanged. */
const PORTED_PAGES: [path: string, heading: RegExp][] = [
  ["/", /^Good (morning|afternoon|evening), Ada$/],
  ["/projects/new", /^New project$/],
  ["/workspace", /^Analytical Engines$/],
  ["/agents", /^Agents & API keys$/],
  ["/p/AA", /^Alpha$/],
];
/** Project pages ported in WH-97 and WH-98, with something only that page shows. */
const PROJECT_PAGES: [path: string, find: () => Promise<unknown>][] = [
  ["/p/AA/overview", () => screen.findByRole("heading", { level: 1, name: "Overview of Alpha" })],
  ["/p/AA/activity", () => screen.findByRole("link", { name: "Everything" })],
  ["/p/AA/map", () => screen.findByRole("tab", { name: /System/ })],
  ["/p/AA/decisions", () => screen.findByRole("heading", { level: 1, name: "Decisions" })],
  ["/p/AA/glossary", () => screen.findByRole("heading", { level: 1, name: "Glossary" })],
  ["/p/AA/docs", () => screen.findByRole("button", { name: "Plan" })],
  ["/p/AA/members", () => screen.findByRole("heading", { level: 1, name: "Project members" })],
  ["/p/AA/settings", () => screen.findByRole("heading", { level: 1, name: "Project settings" })],
  ["/p/AA/repos", () => screen.findByRole("heading", { level: 2, name: "Repositories" })],
  ["/p/AA/onboarding", () => screen.findByRole("heading", { level: 2, name: "Where does your code live?" })],
];
const ADMIN_PAGES: [path: string, heading: RegExp][] = [
  ["/admin/workspaces", /^Workspaces on this server$/],
  ["/admin/workspaces/t2", /^Babbage & Co/],
  ["/admin/invites", /^Invite a new workspace$/],
];
const PUBLIC_PAGES: [path: string, button: RegExp | null, text?: string][] = [
  ["/login", /^Sign in$/],
  ["/signup", /^Create account$/],
  ["/invite", null, "This page needs the full invite link you were sent."],
];
const ALL_APP_PATHS = [...PORTED_PAGES.map(([p]) => p), ...PROJECT_PAGES.map(([p]) => p)];

const inShell = () => {
  const sidebar = screen.getByRole("navigation");
  expect(within(sidebar).getByRole("link", { name: "Home" })).toBeTruthy();
  expect(within(sidebar).getByRole("button", { name: /Alpha|Select a project/ })).toBeTruthy(); // the switcher
  expect(within(sidebar).getByRole("link", { name: "Members" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Account menu" })).toBeTruthy();
};

describe("signed in: every page is in the shell", () => {
  test.each(PORTED_PAGES)("%s is the real page, with the sidebar, the project switcher and the account menu", async (path, heading) => {
    const { at } = renderApp(path);
    await screen.findByRole("heading", { level: 1, name: heading });
    expect(at()).toBe(path);
    expect(screen.queryByTestId("page-stub")).toBeNull();
    inShell();
  });

  test.each(PROJECT_PAGES)("%s is the real page, in the shell", async (path, find) => {
    const { at } = renderApp(path);
    await find();
    expect(at()).toBe(path);
    expect(screen.queryByTestId("page-stub")).toBeNull();
    inShell();
  });

  test("a project page has the project's header and its sections in the sidebar", async () => {
    renderApp("/p/BB/docs");
    await screen.findByRole("button", { name: "Plan" });
    expect(screen.getByRole("heading", { level: 1, name: "Beta" })).toBeTruthy(); // the header names the project, without its key
    const sidebar = screen.getByRole("navigation");
    for (const name of ["Board", "Activity", "Map", "Docs", "Decisions", "Glossary", "Repos"]) expect(within(sidebar).getByRole("link", { name })).toBeTruthy();
    expect(within(sidebar).getByRole("link", { name: "Docs" }).classList.contains("bg-panel-2")).toBe(true); // the current section is marked
  });

  test("the administrator pages are not shown to people who are not administrators", async () => {
    for (const [path] of ADMIN_PAGES) {
      const { unmount, server } = renderApp(path);
      await screen.findByTestId("not-found");
      expect(server.requests.filter((r) => r.includes("/api/app/admin"))).toEqual([]); // and nothing was even asked for
      unmount();
    }
  });

  test("and are shown to administrators", async () => {
    for (const [path, heading] of ADMIN_PAGES) {
      const { unmount } = renderApp(path, (s) => (s.me = { ...ADA, isInstanceAdmin: true }));
      await screen.findByRole("heading", { level: 1, name: heading });
      expect(within(screen.getByRole("navigation")).getByRole("link", { name: "Workspaces" })).toBeTruthy();
      unmount();
    }
  });

  test("an address that is not a page is not found, still inside the shell", async () => {
    renderApp("/nonsense/here");
    await screen.findByTestId("not-found");
    expect(screen.getByRole("navigation")).toBeTruthy();
  });

  test("a project that is not this workspace's is not found", async () => {
    renderApp("/p/ZZ");
    await screen.findByTestId("not-found");
    expect(screen.queryByTestId("page-stub")).toBeNull();
  });

  test("sign-in and sign-up send a signed-in person home", async () => {
    for (const path of ["/login", "/signup"]) {
      const { at, unmount } = renderApp(path);
      await screen.findByRole("heading", { level: 1, name: /^Good / });
      expect(at()).toBe("/");
      unmount();
    }
  });
});

describe("signed out: the gate", () => {
  const signedOutServer = (s: { me: unknown }) => (s.me = null);

  test.each([...ALL_APP_PATHS, ...ADMIN_PAGES.map(([p]) => p), "/nonsense"])("%s redirects to /login before any of the shell is drawn", async (path) => {
    const { at, server } = renderApp(path, signedOutServer);
    await waitFor(() => expect(at()).toBe("/login"));
    await screen.findByRole("button", { name: "Sign in" });
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("button", { name: "Account menu" })).toBeNull();
    expect(server.requests.filter((r) => r.includes("/workspace") || r.includes("/dashboard") || r.includes("/agents"))).toEqual([]); // no page data was asked for
  });

  test.each(PUBLIC_PAGES)("%s is open to anyone", async (path, button, text) => {
    const { at } = renderApp(path, signedOutServer);
    if (button) await screen.findByRole("button", { name: button });
    else await screen.findByText(text!);
    expect(at()).toBe(path);
  });

  test("the offline page needs no sign-in and no server", async () => {
    const { server } = renderApp("/offline", (s) => (s.fail["/api/app/me"] = "network"));
    await screen.findByRole("heading", { name: "You're offline" });
    expect(server.requests).toEqual([]);
  });

  test("the login page does not show the sidebar or the account menu", async () => {
    renderApp("/login", signedOutServer);
    await screen.findByRole("button", { name: "Sign in" });
    expect(screen.getByText("The board your team and your AI agents share.")).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
  });
});

describe("the session ends while the page is open", () => {
  test("the next request that learns it goes to /login and forgets the person", async () => {
    const { at, server, services } = renderApp("/p/AA/docs");
    await screen.findByRole("button", { name: "Plan" });
    server.me = null; // signed out in another tab
    await services.queryClient.invalidateQueries({ queryKey: ["projects"] });
    await waitFor(() => expect(at()).toBe("/login"));
    await screen.findByRole("button", { name: "Sign in" });
    expect(screen.queryByRole("navigation")).toBeNull();
    // What the person's session loaded is gone from memory; only the (empty) answer to "who is signed in" stays.
    await waitFor(() => expect(services.queryClient.getQueryData(["projects"])).toBeUndefined());
    expect(services.queryClient.getQueryData(["me"])).toBeNull();
  });
});

describe("loading and failing", () => {
  test("while the first screen's data loads there is a busy skeleton, not a blank page", async () => {
    let release!: () => void;
    renderApp("/p/AA/docs", (s) => (s.hold = new Promise<void>((r) => (release = r))));
    const status = await screen.findByRole("status");
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Loading Wheelhouse…")).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
    release();
    await screen.findByRole("button", { name: "Plan" });
    expect(screen.queryByText("Loading Wheelhouse…")).toBeNull();
  });

  test("when the server cannot be reached the page says so and offers a reload", async () => {
    renderApp("/", (s) => (s.fail["/api/app/me"] = "network"));
    const error = await screen.findByTestId("route-error");
    expect(within(error).getByText("Cannot reach Wheelhouse")).toBeTruthy();
    expect(within(error).getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(error.getAttribute("role")).toBe("alert");
  });

  test("a server error says Wheelhouse had a problem, with the server's own words", async () => {
    const failure = Response.json({ error: { code: "internal", message: "Internal error" } }, { status: 500 });
    renderApp("/p/AA", (s) => (s.fail["/api/app/projects"] = failure));
    const error = await screen.findByTestId("route-error", {}, { timeout: 5000 });
    expect(within(error).getByText("Wheelhouse had a problem")).toBeTruthy();
    expect(within(error).getByText("Internal error")).toBeTruthy();
  });

  test("a sign-in that expired during the first load is a redirect, not an error page", async () => {
    const { at } = renderApp("/", (s) => (s.fail["/api/app/projects"] = signedOut()));
    await waitFor(() => expect(at()).toBe("/login"));
    expect(screen.queryByTestId("route-error")).toBeNull();
    expect(ApiError).toBeDefined();
  });
});

describe("live updates", () => {
  test("a project page listens to that project's stream; the dashboard listens to the workspace's; other pages to neither", async () => {
    const { unmount } = renderApp("/p/AA/docs");
    await screen.findByRole("button", { name: "Plan" });
    await waitFor(() => expect(FakeEventSource.open.map((s) => s.url)).toEqual(["/api/projects/AA/stream"]));
    unmount();
    FakeEventSource.reset();

    const dash = renderApp("/");
    await screen.findByRole("heading", { level: 1, name: /^Good / });
    await waitFor(() => expect(FakeEventSource.open.map((s) => s.url)).toEqual(["/api/stream"]));
    dash.unmount();
    FakeEventSource.reset();

    renderApp("/workspace");
    await screen.findByRole("heading", { level: 1, name: "Analytical Engines" });
    expect(FakeEventSource.open).toEqual([]);
  });
});
