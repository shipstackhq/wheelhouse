import { describe, expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiError, team, renderApp } from "../test/harness";
import { onboardingPage } from "../test/data";

const key = () => screen.getByLabelText("Key") as HTMLInputElement;

describe("new team", () => {
  test("the key follows the name: initials of several words, up to four letters of one", async () => {
    renderApp("/teams/new");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Name"), "Rocket Launcher Control");
    expect(key().value).toBe("RLC");
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Wheelhouse");
    expect(key().value).toBe("WHEE");
  });

  test("a key the person typed is kept when the name changes, and is upper-cased and limited to six", async () => {
    renderApp("/teams/new");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Name"), "Rocket");
    await user.clear(key());
    await user.type(key(), "abcdefghij");
    expect(key().value).toBe("ABCDEF");
    await user.type(screen.getByLabelText("Name"), " Launcher");
    expect(key().value).toBe("ABCDEF");
  });

  test("creates the team and goes to its set-up page; the switcher lists it at once", async () => {
    const { router, server, services } = renderApp("/teams/new", (s) => {
      s.on("POST /api/app/teams", ({ body }) => {
        const b = body as { name: string; key?: string };
        const created = team(b.key || "NEW", b.name);
        s.teams = [...s.teams, created];
        return Response.json({ team: created }, { status: 201 });
      });
      s.on("GET /api/app/teams/NT/onboarding", onboardingPage("NT", { team: { key: "NT", name: "New Thing" } }));
      s.on("GET /api/app/teams/NT/repositories", { repositories: [] });
      s.on("GET /api/app/teams/NT/docs", { docs: [] });
    });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Name"), "New Thing");
    await user.type(screen.getByLabelText("Description"), "Agents read this.");
    await user.click(screen.getByRole("button", { name: "Create team" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/w/ae/t/NT/onboarding"));
    expect(server.sent("POST /api/app/teams")[0].body).toEqual({ name: "New Thing", key: "NT", description: "Agents read this.", parent: null });
    expect(server.sent("POST /api/app/teams")[0].headers["x-csrf-token"]).toBe("csrf-ada");
    await screen.findByRole("heading", { level: 2, name: "Where does your code live?" });
    const teams = services.queryClient.getQueryData(["ae", "teams"]) as { key: string }[];
    expect(teams.map((p) => p.key)).toContain("NT"); // so the sidebar's switcher and the team header know it at once
    expect(screen.getAllByText("NT").length).toBeGreaterThan(0);
  });

  test("a key that is taken is shown as the server says it, and the form stays", async () => {
    const { router } = renderApp("/teams/new", (s) => s.on("POST /api/app/teams", apiError(409, "conflict", "Team key NT already in use")));
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Name"), "New Thing");
    await user.click(screen.getByRole("button", { name: "Create team" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Team key NT already in use");
    expect(router.state.location.pathname).toBe("/w/ae/teams/new");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("New Thing");
  });

  test("while it is working the button is disabled so it cannot be pressed twice", async () => {
    let release!: () => void;
    renderApp("/teams/new", (s) =>
      s.on("POST /api/app/teams", () => new Promise((r) => (release = () => r(apiError(409, "conflict", "taken"))))),
    );
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Name"), "Slow");
    await user.click(screen.getByRole("button", { name: "Create team" }));
    const busy = await screen.findByRole("button", { name: "Create team" });
    await waitFor(() => expect((busy as HTMLButtonElement).disabled).toBe(true));
    expect(busy.getAttribute("aria-busy")).toBe("true");
    release();
    await screen.findByRole("alert");
    expect((screen.getByRole("button", { name: "Create team" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
