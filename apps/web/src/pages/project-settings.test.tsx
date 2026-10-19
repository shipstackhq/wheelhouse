import { describe, expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiError, renderApp } from "../test/harness";
import { projectMembers } from "../test/data";

const members = (myRole: "admin" | "editor" = "admin") => projectMembers({ myRole });
const open = (setup: Parameters<typeof renderApp>[1] = () => {}, myRole: "admin" | "editor" = "admin") =>
  renderApp("/p/AA/settings", (s) => (s.on("GET /api/app/projects/AA/members", members(myRole)), setup(s)));

describe("the project settings page", () => {
  test("shows the name, the fixed key and the description", async () => {
    open();
    await screen.findByRole("heading", { level: 1, name: "Project settings" });
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Alpha");
    expect((screen.getByLabelText("Key") as HTMLInputElement).readOnly).toBe(true);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();
  });

  test("an admin saves a new name and description", async () => {
    const user = userEvent.setup();
    let body: unknown;
    open((s) =>
      s.on("PATCH /api/app/projects/AA", (req: { body: unknown }) => {
        body = req.body;
        return { project: { id: "p1", key: "AA", name: "Renamed", description: "New words", createdAt: "2026-10-01T00:00:00.000Z" } };
      }),
    );
    const name = await screen.findByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Renamed");
    await user.type(screen.getByLabelText("Description"), "New words");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Saved.");
    expect(body).toMatchObject({ name: "Renamed" });
  });

  test("a refusal from the server is shown", async () => {
    const user = userEvent.setup();
    open((s) => s.on("PATCH /api/app/projects/AA", apiError(403, "forbidden", "Only a project admin can do that")));
    await user.click(await screen.findByRole("button", { name: "Save changes" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Only a project admin can do that");
  });

  test("a project editor only reads: fields are read only and there is no save button", async () => {
    open(() => {}, "editor");
    await screen.findByRole("heading", { level: 1, name: "Project settings" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull());
    expect((screen.getByLabelText("Name") as HTMLInputElement).readOnly).toBe(true);
  });
});
