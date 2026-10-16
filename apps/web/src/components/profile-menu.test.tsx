import { afterEach, describe, expect, test, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Avatar, avatarUrl, ProfileMenu } from "./profile-menu";
import { renderIn } from "../test/harness";

afterEach(() => Reflect.deleteProperty(navigator, "serviceWorker"));
const menu = () => <ProfileMenu name="Ada Lovelace" email="ada@example.test" role="owner" tags={["eng", "lead"]} team="Analytical Engines" />;

describe("the account menu", () => {
  test("shows who you are, your team, your role and your tags", async () => {
    renderIn(menu());
    await userEvent.setup().click(screen.getByRole("button", { name: "Account menu" }));
    const content = await screen.findByText("Analytical Engines");
    const panel = content.closest("div")!.parentElement!;
    expect(within(panel).getAllByText("Ada Lovelace").length).toBeGreaterThan(0);
    expect(within(panel).getAllByText("ada@example.test").length).toBeGreaterThan(0);
    expect(within(panel).getByText("owner")).toBeTruthy();
    expect(within(panel).getByText("eng")).toBeTruthy();
    expect(within(panel).getByText("lead")).toBeTruthy();
    expect(within(panel).getByLabelText("Dark mode")).toBeTruthy();
  });

  test("signing out ends the session, forgets everything in memory, and goes to /login", async () => {
    const wipe = vi.fn();
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration: async () => ({ active: { postMessage: wipe } }) } });
    const { server, services, router } = renderIn(menu(), "/p/AA");
    services.queryClient.setQueryData(["projects"], [{ key: "AA" }]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Account menu" }));
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(server.requests).toContain("POST /api/app/auth/logout");
    expect(wipe).toHaveBeenCalledWith("CLEAR_CACHES");
    expect(services.queryClient.getQueryData(["projects"])).toBeUndefined();
  });

  test("even if the server cannot be reached, the person is sent to /login and nothing stays in memory", async () => {
    const { server, services, router } = renderIn(menu(), "/");
    server.fail["/api/app/auth/logout"] = "network";
    services.queryClient.setQueryData(["projects"], [{ key: "AA" }]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Account menu" }));
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(services.queryClient.getQueryData(["projects"])).toBeUndefined();
  });
});

describe("the avatar", () => {
  test("is a generated picture seeded by the name, and falls back to initials if it cannot load", async () => {
    const { container } = renderIn(<Avatar name="Ada Lovelace" email="ada@example.test" />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(avatarUrl("Ada Lovelace"));
    img.dispatchEvent(new Event("error"));
    expect(await screen.findByText("AL")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });
  test("uses the email when there is no name", () => {
    const { container } = renderIn(<Avatar name=" " email="ada@example.test" />);
    expect(container.querySelector("img")!.getAttribute("src")).toBe(avatarUrl("ada@example.test"));
  });
});
