import { describe, expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiError, renderApp } from "../test/harness";
import { teamMembers } from "../test/data";

const members = (myRole: "admin" | "editor" = "admin") => teamMembers({ myRole });
const open = (setup: Parameters<typeof renderApp>[1] = () => {}, myRole: "admin" | "editor" = "admin") =>
  renderApp("/t/AA/settings", (s) => (s.on("GET /api/app/teams/AA/members", members(myRole)), setup(s)));

describe("the team settings page", () => {
  test("shows the name, the fixed key and the description", async () => {
    open();
    await screen.findByRole("heading", { level: 1, name: "Team settings" });
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Alpha");
    expect((screen.getByLabelText("Key") as HTMLInputElement).readOnly).toBe(true);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();
  });

  test("an admin saves a new name and description", async () => {
    const user = userEvent.setup();
    let body: unknown;
    open((s) =>
      s.on("PATCH /api/app/teams/AA", (req: { body: unknown }) => {
        body = req.body;
        return { team: { id: "p1", key: "AA", name: "Renamed", description: "New words", createdAt: "2026-10-01T00:00:00.000Z" } };
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
    open((s) => s.on("PATCH /api/app/teams/AA", apiError(403, "forbidden", "Only a team admin can do that")));
    await user.click(await screen.findByRole("button", { name: "Save changes" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Only a team admin can do that");
  });

  test("a team editor only reads: fields are read only and there is no save button", async () => {
    open(() => {}, "editor");
    await screen.findByRole("heading", { level: 1, name: "Team settings" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull());
    expect((screen.getByLabelText("Name") as HTMLInputElement).readOnly).toBe(true);
  });
});
