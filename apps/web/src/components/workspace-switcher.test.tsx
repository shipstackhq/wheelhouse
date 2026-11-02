import { describe, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiError, renderIn, serverWithData } from "../test/harness";
import { WorkspaceSwitcher } from "./workspace-switcher";

const openWorkspaces = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: /^Workspace menu/ }));
  await user.click(await screen.findByRole("button", { name: "Workspaces" }));
};

const two = () => {
  const s = serverWithData();
  s.on("GET /api/app/me/workspaces", {
    workspaces: [
      { id: "t1", slug: "ae", name: "Analytical Engines", kind: "personal", role: "owner", active: true },
      { id: "t2", slug: "de", name: "Difference Engines", kind: "team", role: "viewer", active: false },
    ],
  });
  s.on("POST /api/app/me/workspace", { workspace: { id: "t2", name: "Difference Engines" } });
  return s;
};

describe("the workspace switcher", () => {
  test("shows the workspace's name and initial; with one workspace the menu just names it, as the current one", async () => {
    renderIn(<WorkspaceSwitcher name="Analytical Engines" />);
    const button = screen.getByRole("button", { name: /^Workspace menu/ });
    expect(button.getAttribute("aria-label")).toBe("Workspace menu: Analytical Engines");
    expect(button.getAttribute("title")).toBe("Analytical Engines");
    expect(button.textContent).toBe("A"); // a round icon with the initial; the name is in the menu and the tooltip
    expect(button.querySelector("svg")).toBeTruthy(); // the down arrow that says it is a menu
    await openWorkspaces(userEvent.setup());
    const group = await screen.findByRole("group", { name: "Workspaces" });
    const current = within(group).getByRole("button", { name: /Analytical Engines/ }) as HTMLButtonElement;
    expect(current.disabled).toBe(true);
    expect(within(group).getAllByRole("button")).toHaveLength(2); // the workspace and Create workspace
  });

  test("with several it lists them, marks the current one, and switching tells the server and opens the other workspace's address, keeping what was read", async () => {
    const { server, services, router } = renderIn(<WorkspaceSwitcher name="Analytical Engines" />, "/t/AA", two());
    services.queryClient.setQueryData(["marker"], "kept: every key starts with its workspace, so nothing needs forgetting");
    const user = userEvent.setup();
    await openWorkspaces(user);
    const group = await screen.findByRole("group", { name: "Workspaces" });
    await within(group).findByRole("button", { name: /Difference Engines/ });
    const current = within(group).getByRole("button", { name: /Analytical Engines/ }) as HTMLButtonElement;
    expect(current.disabled).toBe(true);
    expect(current.getAttribute("aria-current")).toBe("true");
    expect(within(group).getByText("viewer")).toBeTruthy();
    await user.click(within(group).getByRole("button", { name: /Difference Engines/ }));
    await waitFor(() => expect(server.sent("POST /api/app/me/workspace")).toHaveLength(1));
    expect(server.sent("POST /api/app/me/workspace")[0].body).toEqual({ workspaceId: "t2" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/w/de"));
    expect(services.queryClient.getQueryData(["marker"])).toBeDefined();
  });

  test("in the icon-only rail the icon stays and the down arrow goes (a phone drawer is never the rail, so it keeps it)", () => {
    renderIn(<WorkspaceSwitcher name="Analytical Engines" collapsed />);
    const button = screen.getByRole("button", { name: "Workspace menu: Analytical Engines" });
    expect(button.className).not.toContain("md:hidden");
    expect(button.textContent).toBe("A");
    expect(button.querySelector("svg")!.getAttribute("class")).toContain("md:hidden");
  });

  test("the menu has Settings, which goes to the settings screen", async () => {
    const { router } = renderIn(<WorkspaceSwitcher name="Analytical Engines" />, "/t/AA");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Workspace menu/ }));
    await user.click(await screen.findByRole("link", { name: "Settings" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
  });

  test("Ctrl+2 opens the second workspace", async () => {
    const { server, router } = renderIn(<WorkspaceSwitcher name="Analytical Engines" />, "/t/AA", two());
    await userEvent.setup().keyboard("{Control>}2{/Control}");
    await waitFor(() => expect(server.sent("POST /api/app/me/workspace")).toHaveLength(1));
    await waitFor(() => expect(router.state.location.pathname).toBe("/w/de"));
  });

  test("Create workspace asks for a name, fills the address from it, shows the server's field error, then opens the new workspace", async () => {
    const s = two();
    let calls = 0;
    s.on("POST /api/app/workspaces", () => (++calls === 1 ? apiError(400, "invalid", "x", { fields: { slug: "That address is taken" } }) : { workspace: { id: "t3", slug: "new-co", name: "New Co" } }));
    s.on("POST /api/app/me/workspace", { workspace: { id: "t3", name: "New Co" } });
    const { server, router } = renderIn(<WorkspaceSwitcher name="Analytical Engines" />, "/t/AA", s);
    const user = userEvent.setup();
    await openWorkspaces(user);
    await user.click(await screen.findByRole("button", { name: "Create workspace" }));
    await user.type(await screen.findByLabelText("Name"), "New Co");
    expect((screen.getByLabelText("Address") as HTMLInputElement).value).toBe("new-co");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText("That address is taken")).toBeTruthy();
    expect(server.sent("POST /api/app/workspaces")[0].body).toEqual({ name: "New Co" }); // an address not typed is left to the server
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/w/new-co"));
    expect(server.sent("POST /api/app/me/workspace")[0].body).toEqual({ workspaceId: "t3" });
  });
});
