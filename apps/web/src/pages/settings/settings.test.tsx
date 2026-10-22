import { beforeEach, describe, expect, test } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forgetAppLocation } from "../../lib/app-location";
import { ADA, apiError, renderApp } from "../../test/harness";

const panel = () => within(screen.getByRole("navigation", { name: "Settings" }));

beforeEach(() => forgetAppLocation());

describe("settings as a screen of its own", () => {
  test("/settings opens the profile, in a layout with its own left panel and no app sidebar or header", async () => {
    const { at } = renderApp("/settings");
    await screen.findByRole("heading", { level: 1, name: "Profile" });
    expect(at()).toBe("/settings/profile");
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull(); // not the app's sidebar
    expect(screen.queryByRole("link", { name: "Home" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Workspace menu/ })).toBeNull();
    expect(screen.getByText("ada@example.test")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeTruthy();
  });

  test("the left panel groups Personal and Workspace sections and marks the one you are in", async () => {
    renderApp("/settings/workspace");
    await screen.findByRole("heading", { level: 1, name: "General" });
    const links = panel().getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")]);
    expect(links).toEqual([
      ["Profile", "/settings/profile"],
      ["Password", "/settings/password"],
      ["Devices", "/settings/devices"],
      ["General", "/settings/workspace"],
      ["Members", "/settings/members"],
      ["Agents & API keys", "/settings/agents"],
      ["Teams", "/settings/teams"],
    ]);
    expect(panel().getByText("Personal")).toBeTruthy();
    expect(panel().getByText("Workspace")).toBeTruthy();
    expect(panel().getByRole("link", { name: "General" }).getAttribute("aria-current")).toBe("page");
    expect(panel().getByRole("link", { name: "Profile" }).getAttribute("aria-current")).toBeNull();
  });

  test("Members and Agents & API keys are the same pages, inside settings", async () => {
    const members = renderApp("/settings/members");
    await screen.findByRole("heading", { level: 1, name: "Analytical Engines" });
    expect(screen.getByText("Grace Hopper")).toBeTruthy();
    members.unmount();
    renderApp("/settings/agents");
    await screen.findByRole("heading", { level: 1, name: "Agents & API keys" });
    expect(panel().getByRole("link", { name: "Agents & API keys" }).getAttribute("aria-current")).toBe("page");
  });

  test("the workspace section shows your role and, for an owner, the seats; a member sees no seats", async () => {
    const owner = renderApp("/settings/workspace");
    await screen.findByRole("heading", { level: 1, name: "General" });
    expect(screen.getByText("owner")).toBeTruthy();
    expect(await screen.findByText("2 of 5 used (2 members, 0 pending)")).toBeTruthy();
    owner.unmount();
    renderApp("/settings/workspace", (s) => (s.me = { ...ADA, role: "member" }));
    await screen.findByRole("heading", { level: 1, name: "General" });
    expect(screen.getByText("member")).toBeTruthy();
    expect(screen.queryByText(/used \(/)).toBeNull();
  });

  test("Teams lists your teams, each linking to that team's own settings", async () => {
    renderApp("/settings/teams");
    await screen.findByRole("heading", { level: 1, name: "Teams" });
    expect(screen.getByRole("link", { name: "Settings of Alpha" }).getAttribute("href")).toBe("/t/AA/settings");
  });

  test("an unknown settings address is not found, still in the settings layout", async () => {
    renderApp("/settings/nonsense");
    expect(await screen.findByRole("heading", { name: /not found|nothing here/i })).toBeTruthy();
    expect(panel().getByRole("link", { name: "Profile" })).toBeTruthy();
  });
});

describe("Back to app", () => {
  test("goes back to the app page you were on, with its query", async () => {
    const { router, at } = renderApp("/t/AA/docs?doc=x");
    await screen.findByRole("heading", { name: /Docs|Plan/ }).catch(() => undefined);
    await userEvent.setup().click(await screen.findByRole("link", { name: "Settings" }));
    await screen.findByRole("heading", { level: 1, name: "Profile" });
    expect(at()).toBe("/settings/profile");
    await userEvent.setup().click(screen.getByRole("button", { name: "Back to app" }));
    await screen.findByRole("navigation", { name: "Main" });
    expect(router.state.location.pathname + router.state.location.search).toBe("/t/AA/docs?doc=x");
  });

  test("moving around inside settings does not change where it goes back to", async () => {
    const { at } = renderApp("/projects");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("link", { name: "Settings" }));
    await screen.findByRole("heading", { level: 1, name: "Profile" });
    await user.click(panel().getByRole("link", { name: "Password" }));
    await user.click(panel().getByRole("link", { name: "Teams" }));
    await user.click(screen.getByRole("button", { name: "Back to app" }));
    await screen.findByRole("navigation", { name: "Main" });
    expect(at()).toBe("/projects");
  });

  test("opened directly (a reload, a bookmark) it goes to the home page when nothing is remembered, and to the remembered page when the tab knows one", async () => {
    const first = renderApp("/settings/profile");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Back to app" }));
    await screen.findByRole("navigation", { name: "Main" });
    expect(first.at()).toBe("/");
    first.unmount();
    forgetAppLocation(); // a reload starts with no memory in the page, only what the tab stored
    sessionStorage.setItem("wh:app-location", "/initiatives");
    const second = renderApp("/settings/profile");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Back to app" }));
    await screen.findByRole("navigation", { name: "Main" });
    expect(second.at()).toBe("/initiatives");
  });
});

describe("changing your password, from Settings", () => {
  const fill = async (current: string, next: string) => {
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Current password"), current);
    await user.type(screen.getByLabelText("New password"), next);
    await user.click(screen.getByRole("button", { name: "Update" }));
  };

  test("sends both passwords and confirms", async () => {
    const { server } = renderApp("/settings/password", (s) => s.on("POST /api/app/me/password", { ok: true }));
    await fill("old password 1", "a brand new passphrase");
    expect((await screen.findByRole("status")).textContent).toBe("Password updated");
    expect(server.sent("POST /api/app/me/password")[0].body).toEqual({ current: "old password 1", next: "a brand new passphrase" });
  });

  test("a wrong current password is shown as the server says it", async () => {
    renderApp("/settings/password", (s) => s.on("POST /api/app/me/password", apiError(400, "invalid", "Current password is wrong", { fields: { current: "Current password is wrong" } })));
    await fill("not mine", "a brand new passphrase");
    expect((await screen.findByRole("alert")).textContent).toBe("Current password is wrong");
  });

  test("the new password must be at least twelve characters, even before it is sent", async () => {
    renderApp("/settings/password");
    expect(((await screen.findByLabelText("New password")) as HTMLInputElement).minLength).toBe(12);
  });
});
