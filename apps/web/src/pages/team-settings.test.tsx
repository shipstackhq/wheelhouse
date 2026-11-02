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
    expect(screen.getByText("AA", { selector: "span.font-mono" })).toBeTruthy(); // the key is text, not a field
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

describe("a team's icon", () => {
  const saved = (icon: string | null, iconColor: string | null) => ({ team: { id: "id-AA", key: "AA", name: "Alpha", description: "", createdAt: "2026-10-16T00:00:00.000Z", icon, iconColor } });

  test("an admin picks an icon from the popover; it is saved at once", async () => {
    const { server } = open((s) => s.on("PATCH /api/app/teams/AA", saved("ri:rocket-2", null)));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Change icon" }));
    await user.click(screen.getByRole("button", { name: "rocket" }));
    await waitFor(() => expect(server.sent("PATCH /api/app/teams/AA")).toHaveLength(1));
    expect(server.sent("PATCH /api/app/teams/AA")[0].body).toEqual({ icon: "ri:rocket-2", iconColor: null });
  });

  test("a colour is picked from its own popover and saved at once", async () => {
    const { server } = open((s) => s.on("PATCH /api/app/teams/AA", saved(null, "rose")));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Colour" }));
    await user.click(screen.getByRole("button", { name: "rose" }));
    await waitFor(() => expect(server.sent("PATCH /api/app/teams/AA")).toHaveLength(1));
    expect(server.sent("PATCH /api/app/teams/AA")[0].body).toEqual({ icon: null, iconColor: "rose" });
  });

  test("an emoji is picked on the Emoji tab of the icon popover", async () => {
    const { server } = open((s) => s.on("PATCH /api/app/teams/AA", saved("🚀", null)));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Change icon" }));
    await user.click(screen.getByRole("tab", { name: "Emoji" }));
    await user.click(screen.getByRole("button", { name: "🚀" }));
    await waitFor(() => expect(server.sent("PATCH /api/app/teams/AA")).toHaveLength(1));
    expect(server.sent("PATCH /api/app/teams/AA")[0].body).toEqual({ icon: "🚀", iconColor: null });
  });

  test("a team without a role of admin cannot change the icon", async () => {
    open(() => {}, "editor");
    await screen.findByRole("heading", { level: 1, name: "Team settings" });
    expect(screen.queryByRole("button", { name: "Change icon" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Colour" })).toBeNull();
  });
});

describe("the danger zone", () => {
  const allowed = { allowed: true, reason: null };
  const settings = { team: { id: "id-AA", key: "AA", name: "Alpha", retired: false, retiredAt: null }, myRole: "admin", parent: null, children: [], hiddenChildren: 0, canLeave: allowed, canRetire: allowed, canDelete: allowed };

  test("deleting asks for the key and sends it as ?confirm= (a DELETE has no body the server reads)", async () => {
    const { server } = open((s) => (s.on("GET /api/app/teams/AA/settings", settings), s.on("DELETE /api/app/teams/AA", { ok: true, deleted: "AA" })));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Delete team" }));
    const confirm = screen.getByLabelText(/Type AA to confirm/);
    await user.type(confirm, "aa");
    await user.click(screen.getByRole("button", { name: "Delete AA for good" }));
    await waitFor(() => expect(server.sent("DELETE /api/app/teams/AA")).toHaveLength(1));
    expect(server.sent("DELETE /api/app/teams/AA")[0].url).toBe("/api/app/teams/AA?confirm=aa");
  });
});
