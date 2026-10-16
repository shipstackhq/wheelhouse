import { describe, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { ApiError } from "@wheelhouse/api-client";
import { ADA, renderApp, signedOut } from "../test/harness";
import { FakeEventSource } from "../test/fake-event-source";

/** The pages of the app, by address, with the ticket that ports each. The addresses are the Next app's, unchanged. */
const APP_PAGES: [path: string, owner: string][] = [
  ["/", "WH-95"],
  ["/projects/new", "WH-95"],
  ["/team", "WH-95"],
  ["/agents", "WH-95"],
  ["/p/AA", "WH-96"],
  ["/p/AA/activity", "WH-97"],
  ["/p/AA/map", "WH-97"],
  ["/p/AA/docs", "WH-98"],
  ["/p/AA/decisions", "WH-97"],
  ["/p/AA/glossary", "WH-97"],
  ["/p/AA/repos", "WH-98"],
  ["/p/AA/onboarding", "WH-98"],
];
const ADMIN_PAGES = ["/admin/teams", "/admin/teams/some-id", "/admin/invites"];
const PUBLIC_PAGES: [string, string][] = [["/login", "WH-95"], ["/signup", "WH-95"], ["/invite", "WH-95"]];

describe("signed in: every page is in the shell", () => {
  test.each(APP_PAGES)("%s shows the sidebar, the project switcher and the page body", async (path, owner) => {
    const { at } = renderApp(path);
    const body = await screen.findByTestId("page-stub");
    expect(body.dataset.owner).toBe(owner);
    expect(at()).toBe(path);
    const sidebar = screen.getByRole("navigation");
    expect(within(sidebar).getByRole("link", { name: "Home" })).toBeTruthy();
    expect(within(sidebar).getByRole("button", { name: /Alpha|Select a project/ })).toBeTruthy(); // the switcher
    expect(within(sidebar).getByRole("link", { name: "Members" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Account menu" })).toBeTruthy();
  });

  test("a project page has the project's header and its sections in the sidebar", async () => {
    renderApp("/p/BB/docs");
    await screen.findByTestId("page-stub");
    expect(screen.getAllByText("BB").length).toBeGreaterThan(0);
    const sidebar = screen.getByRole("navigation");
    for (const name of ["Board", "Activity", "Map", "Docs", "Decisions", "Glossary", "Repos"]) expect(within(sidebar).getByRole("link", { name })).toBeTruthy();
    expect(within(sidebar).getByRole("link", { name: "Docs" }).classList.contains("bg-panel-2")).toBe(true); // the current section is marked
  });

  test("the administrator pages are not shown to people who are not administrators", async () => {
    for (const path of ADMIN_PAGES) {
      const { unmount } = renderApp(path);
      await screen.findByTestId("not-found");
      expect(screen.queryByTestId("page-stub")).toBeNull();
      unmount();
    }
  });

  test("and are shown to administrators", async () => {
    for (const path of ADMIN_PAGES) {
      const { unmount } = renderApp(path, (s) => (s.me = { ...ADA, isInstanceAdmin: true }));
      expect((await screen.findByTestId("page-stub")).dataset.owner).toBe("WH-95");
      expect(within(screen.getByRole("navigation")).getByRole("link", { name: "Teams" })).toBeTruthy();
      unmount();
    }
  });

  test("an address that is not a page is not found, still inside the shell", async () => {
    renderApp("/nonsense/here");
    await screen.findByTestId("not-found");
    expect(screen.getByRole("navigation")).toBeTruthy();
  });

  test("a project that is not this team's is not found", async () => {
    renderApp("/p/ZZ");
    await screen.findByTestId("not-found");
    expect(screen.queryByTestId("page-stub")).toBeNull();
  });

  test("sign-in and sign-up send a signed-in person home", async () => {
    for (const path of ["/login", "/signup"]) {
      const { at, unmount } = renderApp(path);
      await screen.findByTestId("page-stub");
      expect(at()).toBe("/");
      unmount();
    }
  });
});

describe("signed out: the gate", () => {
  const signedOutServer = (s: { me: unknown }) => (s.me = null);

  test.each([...APP_PAGES.map(([p]) => p), ...ADMIN_PAGES, "/nonsense"])("%s redirects to /login before any of the shell is drawn", async (path) => {
    const { at } = renderApp(path, signedOutServer);
    await waitFor(() => expect(at()).toBe("/login"));
    expect((await screen.findByTestId("page-stub")).dataset.owner).toBe("WH-95");
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("button", { name: "Account menu" })).toBeNull();
  });

  test.each(PUBLIC_PAGES)("%s is open to anyone", async (path, owner) => {
    const { at } = renderApp(path, signedOutServer);
    expect((await screen.findByTestId("page-stub")).dataset.owner).toBe(owner);
    expect(at()).toBe(path);
  });

  test("the offline page needs no sign-in and no server", async () => {
    const { server } = renderApp("/offline", (s) => (s.fail["/api/app/me"] = "network"));
    await screen.findByRole("heading", { name: "You're offline" });
    expect(server.requests).toEqual([]);
  });

  test("the login page does not show the sidebar or the account menu", async () => {
    renderApp("/login", signedOutServer);
    await screen.findByTestId("page-stub");
    expect(screen.getByText("The board your team and your AI agents share.")).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
  });
});

describe("the session ends while the page is open", () => {
  test("the next request that learns it goes to /login and forgets the person", async () => {
    const { at, server, services } = renderApp("/p/AA");
    await screen.findByTestId("page-stub");
    server.me = null; // signed out in another tab
    await services.queryClient.invalidateQueries({ queryKey: ["projects"] });
    await waitFor(() => expect(at()).toBe("/login"));
    await screen.findByTestId("page-stub");
    expect(screen.queryByRole("navigation")).toBeNull();
    // What the person's session loaded is gone from memory; only the (empty) answer to "who is signed in" stays.
    await waitFor(() => expect(services.queryClient.getQueryData(["projects"])).toBeUndefined());
    expect(services.queryClient.getQueryData(["me"])).toBeNull();
  });
});

describe("loading and failing", () => {
  test("while the first screen's data loads there is a busy skeleton, not a blank page", async () => {
    let release!: () => void;
    renderApp("/p/AA", (s) => (s.hold = new Promise<void>((r) => (release = r))));
    const status = await screen.findByRole("status");
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Loading Wheelhouse…")).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
    release();
    await screen.findByTestId("page-stub");
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
  test("a project page listens to that project's stream; the dashboard listens to the team's; other pages to neither", async () => {
    const { unmount } = renderApp("/p/AA/docs");
    await screen.findByTestId("page-stub");
    await waitFor(() => expect(FakeEventSource.open.map((s) => s.url)).toEqual(["/api/projects/AA/stream"]));
    unmount();
    FakeEventSource.reset();

    const dash = renderApp("/");
    await screen.findByTestId("page-stub");
    await waitFor(() => expect(FakeEventSource.open.map((s) => s.url)).toEqual(["/api/stream"]));
    dash.unmount();
    FakeEventSource.reset();

    renderApp("/team");
    await screen.findByTestId("page-stub");
    expect(FakeEventSource.open).toEqual([]);
  });
});
