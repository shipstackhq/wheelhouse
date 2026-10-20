import { describe, expect, test } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ADA, apiError, renderApp } from "../test/harness";

const main = () => within(screen.getByRole("main"));

describe("the settings page", () => {
  test("yours first, then the workspace's: who you are, your role, the workspace and its seats", async () => {
    renderApp("/settings");
    await screen.findByRole("heading", { level: 1, name: "Settings" });
    const personal = within(screen.getByRole("region", { name: "Personal" }));
    expect(personal.getByText("Ada Lovelace")).toBeTruthy();
    expect(personal.getByText("ada@example.test")).toBeTruthy();
    expect(personal.getByRole("heading", { name: "Appearance" })).toBeTruthy();
    const workspace = within(screen.getByRole("region", { name: "Workspace" }));
    expect(workspace.getByRole("heading", { name: "Analytical Engines" })).toBeTruthy();
    expect(workspace.getByText("owner")).toBeTruthy();
    expect(workspace.getByText("eng")).toBeTruthy();
    expect(await workspace.findByText("2 of 5 used (2 members, 0 pending)")).toBeTruthy();
    const order = [...document.querySelectorAll("h2")].map((h) => h.textContent);
    expect(order).toEqual(["Personal", "Workspace"]);
  });

  test("it is the door to the places where people, keys and teams are managed", async () => {
    renderApp("/settings");
    await screen.findByRole("heading", { level: 1, name: "Settings" });
    expect(main().getByRole("link", { name: /^Members/ }).getAttribute("href")).toBe("/workspace");
    expect(await main().findByText("2 people, roles and invites")).toBeTruthy();
    expect(main().getByRole("link", { name: /^Agents & API keys/ }).getAttribute("href")).toBe("/agents");
    expect(main().getByRole("link", { name: "Settings of Alpha" }).getAttribute("href")).toBe("/t/AA/settings");
  });

  test("a member sees no seats line, only what is theirs to know", async () => {
    renderApp("/settings", (s) => (s.me = { ...ADA, role: "member" }));
    await screen.findByRole("heading", { level: 1, name: "Settings" });
    const workspace = within(screen.getByRole("region", { name: "Workspace" }));
    expect(workspace.getByText("member")).toBeTruthy();
    expect(workspace.queryByText(/seats/i)).toBeNull();
    expect(workspace.queryByText(/used \(/)).toBeNull();
  });

  test("is in the shell: the sidebar's Settings link is the current page", async () => {
    renderApp("/settings");
    await screen.findByRole("heading", { level: 1, name: "Settings" });
    const link = within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: "Settings" });
    expect(link.getAttribute("aria-current")).toBe("page");
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
    const { server } = renderApp("/settings", (s) => s.on("POST /api/app/me/password", { ok: true }));
    await fill("old password 1", "a brand new passphrase");
    expect((await screen.findByRole("status")).textContent).toBe("Password updated");
    expect(server.sent("POST /api/app/me/password")[0].body).toEqual({ current: "old password 1", next: "a brand new passphrase" });
  });

  test("a wrong current password is shown as the server says it", async () => {
    renderApp("/settings", (s) => s.on("POST /api/app/me/password", apiError(400, "invalid", "Current password is wrong", { fields: { current: "Current password is wrong" } })));
    await fill("not mine", "a brand new passphrase");
    expect((await screen.findByRole("alert")).textContent).toBe("Current password is wrong");
  });

  test("the new password must be at least twelve characters, even before it is sent", async () => {
    renderApp("/settings");
    expect(((await screen.findByLabelText("New password")) as HTMLInputElement).minLength).toBe(12);
    expect((screen.getByLabelText("Current password") as HTMLInputElement).autocomplete).toBe("current-password");
  });
});
