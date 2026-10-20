import { describe, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderIn, serverWithData } from "../test/harness";
import { WorkspaceSwitcher } from "./workspace-switcher";

const two = () => {
  const s = serverWithData();
  s.on("GET /api/app/me/workspaces", {
    workspaces: [
      { id: "t1", name: "Analytical Engines", role: "owner", active: true },
      { id: "t2", name: "Difference Engines", role: "viewer", active: false },
    ],
  });
  s.on("POST /api/app/me/workspace", { workspace: { id: "t2", name: "Difference Engines" } });
  return s;
};

describe("the workspace switcher", () => {
  test("shows the workspace's name and initial; with one workspace the menu just names it, as the current one", async () => {
    renderIn(<WorkspaceSwitcher name="Analytical Engines" />);
    const button = screen.getByRole("button", { name: "Workspace menu" });
    expect(button.textContent).toContain("Analytical Engines");
    expect(button.textContent).toContain("A");
    await userEvent.setup().click(button);
    const group = await screen.findByRole("group", { name: "Workspaces" });
    const current = within(group).getByRole("button", { name: /Analytical Engines/ }) as HTMLButtonElement;
    expect(current.disabled).toBe(true);
    expect(within(group).getAllByRole("button")).toHaveLength(1);
  });

  test("with several it lists them, marks the current one, and switching moves the session and forgets everything read", async () => {
    const { server, services, router } = renderIn(<WorkspaceSwitcher name="Analytical Engines" />, "/t/AA", two());
    services.queryClient.setQueryData(["marker"], "from the old workspace");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Workspace menu" }));
    const group = await screen.findByRole("group", { name: "Workspaces" });
    await within(group).findByRole("button", { name: /Difference Engines/ });
    const current = within(group).getByRole("button", { name: /Analytical Engines/ }) as HTMLButtonElement;
    expect(current.disabled).toBe(true);
    expect(current.getAttribute("aria-current")).toBe("true");
    expect(within(group).getByText("viewer")).toBeTruthy();
    await user.click(within(group).getByRole("button", { name: /Difference Engines/ }));
    await waitFor(() => expect(server.sent("POST /api/app/me/workspace")).toHaveLength(1));
    expect(server.sent("POST /api/app/me/workspace")[0].body).toEqual({ workspaceId: "t2" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(services.queryClient.getQueryData(["marker"])).toBeUndefined(); // nothing from the old workspace lingers
  });

  test("as the rail it shows only the initial, named for screen readers", () => {
    renderIn(<WorkspaceSwitcher name="Analytical Engines" collapsed />);
    const button = screen.getByRole("button", { name: "Workspace: Analytical Engines" });
    expect(button.textContent).toContain("A");
    expect(screen.getByText("Analytical Engines").className).toContain("md:hidden");
  });
});
