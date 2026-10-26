import { beforeEach, describe, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forgetAppLocation } from "../../lib/app-location";
import { ADA, apiError, renderApp } from "../../test/harness";
import { workspace } from "../../test/data";

const panel = () => within(screen.getByRole("navigation", { name: "Settings" }));

beforeEach(() => forgetAppLocation());

async function waitForElement(id: string) {
  for (let i = 0; i < 50; i++) {
    const el = document.getElementById(id);
    if (el) return el;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`#${id} never appeared`);
}

describe("settings as a screen of its own", () => {
  test("its panel is the app sidebar's frame: the same width, and a phone drawer with a menu button", async () => {
    const { unmount } = renderApp("/settings/profile");
    await screen.findByRole("heading", { level: 1, name: "Profile" });
    const settingsWidth = document.getElementById("settings-sidebar")!.className.match(/\bw-\d+\b/)?.[0];
    expect(screen.getByRole("button", { name: "Open menu" }).getAttribute("aria-controls")).toBe("settings-sidebar");
    unmount();
    renderApp("/");
    const appSidebar = await waitForElement("app-sidebar");
    expect(settingsWidth).toBeTruthy();
    expect(appSidebar.className.match(/\bw-\d+\b/)?.[0]).toBe(settingsWidth);
  });

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

  test("the left panel groups Personal, Workspace and Integrations sections and marks the one you are in", async () => {
    renderApp("/settings/workspace");
    await screen.findByRole("heading", { level: 1, name: "General" });
    const links = panel().getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")]);
    expect(links).toEqual([
      ["Profile", "/settings/profile"],
      ["Password", "/settings/password"],
      ["Devices", "/settings/devices"],
      ["General", "/w/ae/settings/workspace"],
      ["Members", "/w/ae/settings/members"],
      ["API keys", "/w/ae/settings/api-keys"],
      ["Teams", "/w/ae/settings/teams"],
      ["GitHub", "/w/ae/settings/integrations/github"],
    ]);
    expect(panel().getByText("Personal")).toBeTruthy();
    expect(panel().getByText("Workspace")).toBeTruthy();
    expect(panel().getByText("Integrations")).toBeTruthy();
    expect(panel().getByRole("link", { name: "General" }).getAttribute("aria-current")).toBe("page");
    expect(panel().getByRole("link", { name: "Profile" }).getAttribute("aria-current")).toBeNull();
  });

  test("Integrations lists what can be connected, and GitHub is the repositories page, inside settings", async () => {
    const overview = renderApp("/settings/integrations");
    await screen.findByRole("heading", { level: 1, name: "Integrations" });
    await userEvent.click(screen.getAllByRole("link", { name: "GitHub" }).at(-1)!); // the card, after the sidebar entry
    await screen.findByRole("heading", { level: 1, name: "GitHub" });
    expect(await screen.findByRole("heading", { level: 2, name: "Repositories" })).toBeTruthy();
    expect(panel().getByRole("link", { name: "GitHub" }).getAttribute("aria-current")).toBe("page");
    overview.unmount();
  });

  test("the GitHub page works on the team in the address, else the first team, and the team pages no longer have a Repos entry", async () => {
    const other = renderApp("/settings/integrations/github?team=BB");
    await screen.findByRole("heading", { level: 1, name: "GitHub" });
    expect(await screen.findByRole("combobox", { name: "Team" })).toBeTruthy();
    other.unmount();
    renderApp("/t/AA");
    expect(await screen.findByRole("navigation", { name: "Main" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Repos" })).toBeNull();
  });

  test("Members and API keys are the same pages, inside settings", async () => {
    const members = renderApp("/settings/members");
    await screen.findByRole("heading", { level: 1, name: "Analytical Engines" });
    expect(screen.getByText("Grace Hopper")).toBeTruthy();
    members.unmount();
    renderApp("/settings/api-keys");
    await screen.findByRole("heading", { level: 1, name: "API keys" });
    expect(panel().getByRole("link", { name: "API keys" }).getAttribute("aria-current")).toBe("page");
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

  test("a guest has no Members entry and cannot start a team", async () => {
    renderApp("/settings/workspace", (s) => (s.me = { ...ADA, role: "guest" }));
    await screen.findByRole("heading", { level: 1, name: "General" });
    expect(panel().getByRole("link", { name: "General" })).toBeTruthy();
    expect(panel().queryByRole("link", { name: "Members" })).toBeNull();
    expect(screen.queryByText("Transfer ownership")).toBeNull();
  });

  test("an owner offers ownership to another member and can withdraw the offer", async () => {
    const { server } = renderApp("/settings/workspace", (s) => {
      s.on("POST /api/app/workspace/transfer", { ok: true });
      s.on("DELETE /api/app/workspace/transfer", { ok: true });
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Transfer" }));
    await waitFor(() => expect(server.sent("POST /api/app/workspace/transfer")[0]?.body).toEqual({ userId: "u2" }));
  });

  test("the person offered ownership can accept or decline", async () => {
    const { server } = renderApp("/settings/workspace", (s) => {
      s.me = { ...ADA, role: "member" };
      s.on("GET /api/app/workspace", workspace({ role: "member", transfer: { userId: ADA.user.id, name: ADA.user.name } }));
      s.on("POST /api/app/workspace/transfer/accept", { ok: true });
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Accept" }));
    await waitFor(() => expect(server.sent("POST /api/app/workspace/transfer/accept")).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Decline" })).toBeTruthy();
  });

  test("Teams lists your teams, each linking to that team's own settings", async () => {
    renderApp("/settings/teams");
    await screen.findByRole("heading", { level: 1, name: "Teams" });
    expect(screen.getByRole("link", { name: "Settings of Alpha" }).getAttribute("href")).toBe("/w/ae/t/AA/settings");
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
    expect(router.state.location.pathname + router.state.location.search).toBe("/w/ae/t/AA/docs?doc=x");
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
    sessionStorage.setItem("wh:app-location", "/w/ae/initiatives");
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
