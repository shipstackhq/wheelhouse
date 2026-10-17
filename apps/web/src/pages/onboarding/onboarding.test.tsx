import { describe, expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiError, renderApp } from "../../test/harness";
import { onboardingPage, repo } from "../../test/data";

const open = (setup: Parameters<typeof renderApp>[1] = () => {}) => renderApp("/p/AA/onboarding", setup);
const step = async (title: string) => screen.findByRole("heading", { level: 2, name: title });
const current = () => document.querySelector('li[aria-current="step"]')?.textContent;

describe("the onboarding wizard", () => {
  test("shows the project and four steps, starting at where the code lives", async () => {
    open();
    await step("Where does your code live?");
    expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0);
    expect([...document.querySelectorAll("ol li")].map((l) => l.textContent)).toEqual(["1. Code location", "2. Connect agents", "3. First map", "4. Invite teammates"]);
    expect(current()).toBe("1. Code location");
  });

  test("Skip to board is always there, and goes to the board", async () => {
    const { at } = open();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Skip to board" }));
    await waitFor(() => expect(at()).toBe("/p/AA"));
  });

  test("a project that already has a repository starts with GitHub chosen", async () => {
    open((s) => s.on("GET /api/app/projects/AA/onboarding", onboardingPage("AA", { hasRepos: true })));
    await step("Where does your code live?");
    expect(screen.getByRole("button", { name: /Connect GitHub/ }).getAttribute("aria-pressed")).toBe("true");
    expect(await screen.findByRole("heading", { level: 2, name: "GitHub" })).toBeTruthy();
  });

  test("each choice shows what it needs: GitHub the connection card, local the repository list, 'no code' a description", async () => {
    open();
    const user = userEvent.setup();
    await step("Where does your code live?");
    expect(screen.queryByRole("heading", { level: 2, name: "GitHub" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /Connect GitHub/ }));
    expect(await screen.findByRole("heading", { level: 2, name: "GitHub" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Local or another Git host/ }));
    expect(await screen.findByRole("heading", { level: 2, name: "Repositories" })).toBeTruthy();
    expect(await screen.findByText("Backend")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /No code yet/ }));
    expect(await screen.findByLabelText(/What are you building/)).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2, name: "Repositories" })).toBeNull();
  });

  test("'No code yet': the description starts the map; an empty one is refused with the server's words", async () => {
    let calls = 0;
    const { server } = open((s) =>
      s.on("POST /api/app/projects/AA/onboarding/concept", () => (++calls === 1 ? apiError(400, "invalid", "Write a few sentences about what you're building.", { fields: { description: "Write a few sentences about what you're building." } }) : { ok: true })),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /No code yet/ }));
    await user.click(screen.getByRole("button", { name: "Start the map" }));
    expect(await screen.findByText("Write a few sentences about what you're building.")).toBeTruthy();
    expect(server.sent("POST /api/app/projects/AA/onboarding/concept")[0].body).toEqual({ description: "" });
    await user.type(screen.getByLabelText(/What are you building/), "A tool that imports invoices.");
    await user.click(screen.getByRole("button", { name: "Start the map" }));
    expect(await screen.findByText("Added to the map.")).toBeTruthy();
    expect(server.sent("POST /api/app/projects/AA/onboarding/concept")[1].body).toEqual({ description: "A tool that imports invoices." });
    expect(server.sent("POST /api/app/projects/AA/onboarding/concept")[1].headers["x-csrf-token"]).toBe("csrf-ada");
  });

  test("the button reads 'Skip for now' until a choice is made, then 'Continue'", async () => {
    open();
    const user = userEvent.setup();
    await step("Where does your code live?");
    expect(screen.getByRole("button", { name: "Skip for now", exact: true } as never)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /^Skip for now Decide later/ }));
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  });

  test("Connect agents shows the setup guide with this project's key, steering to the plugin when there is code", async () => {
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Local or another Git host/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await step("Connect your agents");
    expect(current()).toBe("2. Connect agents");
    expect(screen.getByText(/Since your code lives in a connected repo, setup A \(the plugin\)/)).toBeTruthy();
    expect(document.body.textContent).toContain("/wheelhouse:setup AA");
    await user.click(screen.getByRole("button", { name: "Back" }));
    await step("Where does your code live?");
  });

  test("with no code the guide steers to plain MCP", async () => {
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /No code yet/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await step("Connect your agents");
    expect(screen.getByText(/Plain MCP tools work either way/)).toBeTruthy();
  });

  test("First map: with code, the commands to build it; without, the note that the concept already seeded it", async () => {
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Local or another Git host/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await step("First map");
    expect(current()).toBe("3. First map");
    expect(document.body.textContent).toContain("/wheelhouse:map-codebase AA");
    expect(document.body.textContent).toContain("/wheelhouse:map-schema AA");
  });

  test("First map with no code has no commands", async () => {
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Skip for now Decide later/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await step("First map");
    expect(screen.getByText(/No code yet — the concept you wrote in the previous step already seeded/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("/wheelhouse:map-codebase");
  });

  test("Invite teammates creates a one-time link, and Done goes to the board", async () => {
    const { server, at } = open((s) =>
      s.on("POST /api/app/invites", { id: "i1", email: "grace@example.test", kind: "join_team", expiresAt: "2026-10-30T00:00:00.000Z", link: "https://wh.example.test/invite#SECRET" }),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Skip for now Decide later/ }));
    for (let i = 0; i < 3; i++) await user.click(await screen.findByRole("button", { name: "Continue" }));
    await step("Invite teammates");
    expect(current()).toBe("4. Invite teammates");
    await user.type(screen.getByPlaceholderText("Their email"), "grace@example.test");
    await user.click(screen.getByRole("button", { name: "Create invite link" }));
    await waitFor(() => expect(server.sent("POST /api/app/invites")).toHaveLength(1));
    expect(server.sent("POST /api/app/invites")[0].body).toMatchObject({ kind: "join_team", email: "grace@example.test", role: "member" });
    expect(await screen.findByText(/Invite created for grace@example.test/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Done — go to board" }));
    await waitFor(() => expect(at()).toBe("/p/AA"));
  });

  test("another team's project, or one that does not exist, is not found", async () => {
    renderApp("/p/ZZ/onboarding");
    expect(await screen.findByText(/not found|doesn.t exist|can.t find/i)).toBeTruthy();
  });

  test("the repository list in the 'local' step updates when one is added", async () => {
    const { server } = open((s) => {
      let repos = [repo()];
      s.on("GET /api/app/projects/AA/repositories", () => ({ repositories: repos }));
      s.on("POST /api/app/projects/AA/repositories", () => {
        repos = [...repos, repo({ id: "r2", displayName: "Mobile", role: "ios" })];
        return { repository: repos[1] };
      });
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Local or another Git host/ }));
    await user.click(await screen.findByRole("button", { name: "+ Add repository" }));
    await user.type(screen.getByPlaceholderText(/^Display name/), "Mobile");
    await user.type(screen.getByPlaceholderText(/^Role/), "ios");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Mobile", { selector: ".font-semibold" })).toBeTruthy();
    expect(server.sent("POST /api/app/projects/AA/repositories")).toHaveLength(1);
  });
});
