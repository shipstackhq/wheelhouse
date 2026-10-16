import { describe, expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiError, project, renderApp } from "../test/harness";

const key = () => screen.getByLabelText("Key") as HTMLInputElement;

describe("new project", () => {
  test("the key follows the name: initials of several words, up to four letters of one", async () => {
    renderApp("/projects/new");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Name"), "Rocket Launcher Control");
    expect(key().value).toBe("RLC");
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Wheelhouse");
    expect(key().value).toBe("WHEE");
  });

  test("a key the person typed is kept when the name changes, and is upper-cased and limited to six", async () => {
    renderApp("/projects/new");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Name"), "Rocket");
    await user.clear(key());
    await user.type(key(), "abcdefghij");
    expect(key().value).toBe("ABCDEF");
    await user.type(screen.getByLabelText("Name"), " Launcher");
    expect(key().value).toBe("ABCDEF");
  });

  test("creates the project and goes to its set-up page; the switcher lists it at once", async () => {
    const { router, server, services } = renderApp("/projects/new", (s) => {
      s.on("POST /api/app/projects", ({ body }) => {
        const b = body as { name: string; key?: string };
        const created = project(b.key || "NEW", b.name);
        s.projects = [...s.projects, created];
        return Response.json({ project: created }, { status: 201 });
      });
    });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Name"), "New Thing");
    await user.type(screen.getByLabelText("Description"), "Agents read this.");
    await user.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/NT/onboarding"));
    expect(server.sent("POST /api/app/projects")[0].body).toEqual({ name: "New Thing", key: "NT", description: "Agents read this." });
    expect(server.sent("POST /api/app/projects")[0].headers["x-csrf-token"]).toBe("csrf-ada");
    await screen.findByTestId("page-stub");
    const projects = services.queryClient.getQueryData(["projects"]) as { key: string }[];
    expect(projects.map((p) => p.key)).toContain("NT"); // so the sidebar's switcher and the project header know it at once
    expect(screen.getAllByText("NT").length).toBeGreaterThan(0);
  });

  test("a key that is taken is shown as the server says it, and the form stays", async () => {
    const { router } = renderApp("/projects/new", (s) => s.on("POST /api/app/projects", apiError(409, "conflict", "Project key NT already in use")));
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Name"), "New Thing");
    await user.click(screen.getByRole("button", { name: "Create project" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Project key NT already in use");
    expect(router.state.location.pathname).toBe("/projects/new");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("New Thing");
  });

  test("while it is working the button is disabled so it cannot be pressed twice", async () => {
    let release!: () => void;
    renderApp("/projects/new", (s) =>
      s.on("POST /api/app/projects", () => new Promise((r) => (release = () => r(apiError(409, "conflict", "taken"))))),
    );
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Name"), "Slow");
    await user.click(screen.getByRole("button", { name: "Create project" }));
    const busy = await screen.findByRole("button", { name: "Create project" });
    await waitFor(() => expect((busy as HTMLButtonElement).disabled).toBe(true));
    expect(busy.getAttribute("aria-busy")).toBe("true");
    release();
    await screen.findByRole("alert");
    expect((screen.getByRole("button", { name: "Create project" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
