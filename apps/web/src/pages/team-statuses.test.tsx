import { describe, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiError, renderApp } from "../test/harness";
import { statusSettings, teamMembers } from "../test/data";

const open = (setup: Parameters<typeof renderApp>[1] = () => {}, myRole: "admin" | "editor" = "admin") =>
  renderApp("/t/AA/settings", (s) => (s.on("GET /api/app/teams/AA/members", teamMembers({ myRole })), setup(s)));
const section = async () => within(await screen.findByRole("heading", { level: 2, name: "Statuses" }).then((h) => h.closest(".space-y-2") as HTMLElement));
const row = (name: string) => document.querySelector(`[data-status="${name}"]`) as HTMLElement;

/** Todo has two statuses (so a default means something): Todo with two issues, and Blocked with one. */
const WITH_BLOCKED = (all: ReturnType<typeof statusSettings>) => {
  const i = all.findIndex((s) => s.name === "Todo");
  return [...all.slice(0, i + 1), { ...all[i], id: "c-blocked", name: "Blocked", isDefault: false, issueCount: 1, position: 2500 }, ...all.slice(i + 1)];
};

describe("the statuses section of the team settings", () => {
  test("lists the statuses under their roles, each with its icon, name and issue count", async () => {
    open();
    const s = await section();
    for (const role of ["Backlog", "Todo", "In progress", "Review", "Done", "Canceled"]) expect(await screen.findByRole("region", { name: role })).toBeTruthy();
    expect(((await s.findByLabelText("Name of Todo")) as HTMLInputElement).value).toBe("Todo");
    expect(within(row("Todo")).getByText("2 issues")).toBeTruthy();
    expect(within(row("Backlog")).getByText("1 issue")).toBeTruthy();
    expect(within(row("Done")).getByText("0 issues")).toBeTruthy();
    expect(row("Done").querySelector("[data-status-icon='done']")).toBeTruthy();
    expect(row("Canceled").querySelector("[data-status-icon='canceled']")).toBeTruthy();
  });

  test("a team editor only reads: the names are text and there is nothing to change", async () => {
    open(() => {}, "editor");
    await screen.findByRole("heading", { level: 2, name: "Statuses" });
    await waitFor(() => expect(screen.getByRole("region", { name: "Todo" })).toBeTruthy());
    expect(screen.queryByLabelText("Name of Todo")).toBeNull();
    expect(within(row("Todo")).getByText("Todo")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Delete / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Reorder / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Add / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Colour of / })).toBeNull();
  });

  describe("renaming", () => {
    test("leaving the name field saves a new name with the status's id; Enter does the same", async () => {
      const { server } = open((s) => s.on("PATCH /api/app/teams/AA/statuses/c-todo", { status: {} }));
      const user = userEvent.setup();
      const input = (await (await section()).findByLabelText("Name of Todo")) as HTMLInputElement;
      await user.clear(input);
      await user.type(input, "Up next{Enter}");
      await waitFor(() => expect(server.sent("PATCH /api/app/teams/AA/statuses/c-todo")).toHaveLength(1));
      expect(server.sent("PATCH /api/app/teams/AA/statuses/c-todo")[0].body).toEqual({ name: "Up next" });
      await waitFor(() => expect(server.sent("GET /api/app/teams/AA/statuses").length).toBeGreaterThan(1)); // read again
    });
    test("an unchanged, emptied or escaped name sends nothing", async () => {
      const { server } = open();
      const user = userEvent.setup();
      const s = await section();
      const input = (await s.findByLabelText("Name of Todo")) as HTMLInputElement;
      await user.click(input);
      await user.tab(); // unchanged
      await user.clear(input);
      await user.tab(); // emptied: put back
      await waitFor(() => expect(input.value).toBe("Todo"));
      await user.type(input, "xyz{Escape}");
      expect(input.value).toBe("Todo");
      expect(server.calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
    });
  });

  describe("colour", () => {
    test("a colour from the palette is saved; 'Colour of its role' clears it", async () => {
      const { server } = open((s) => {
        s.on("GET /api/app/teams/AA/statuses", { statuses: statusSettings([{}, { color: "amber" }]) });
        s.on("PATCH /api/app/teams/AA/statuses/c-todo", { status: {} });
      });
      const user = userEvent.setup();
      await section();
      await user.click(await screen.findByRole("button", { name: "Colour of Todo" }));
      await user.click(await screen.findByRole("menuitem", { name: "violet" }));
      await waitFor(() => expect(server.sent("PATCH /api/app/teams/AA/statuses/c-todo")).toHaveLength(1));
      expect(server.sent("PATCH /api/app/teams/AA/statuses/c-todo")[0].body).toEqual({ color: "violet" });
      await user.click(screen.getByRole("button", { name: "Colour of Todo" }));
      await user.click(await screen.findByRole("menuitem", { name: "Colour of its role" }));
      await waitFor(() => expect(server.sent("PATCH /api/app/teams/AA/statuses/c-todo")).toHaveLength(2));
      expect(server.sent("PATCH /api/app/teams/AA/statuses/c-todo")[1].body).toEqual({ color: null });
    });
    test("a chosen colour is the one the icon is drawn in", async () => {
      open((s) => s.on("GET /api/app/teams/AA/statuses", { statuses: statusSettings([{}, { color: "rose" }]) }));
      await section();
      await waitFor(() => expect(row("Todo")?.querySelector("[data-status-icon]")?.getAttribute("class")).toContain("text-rose-500"));
      expect(row("Done").querySelector("[data-status-icon]")?.getAttribute("class")).toContain("text-emerald-500"); // its role's own
    });
  });

  describe("the default of a role", () => {
    test("only a role with several statuses shows which is the default, and another can be made it", async () => {
      const { server } = open((s) => {
        s.on("GET /api/app/teams/AA/statuses", { statuses: statusSettings(WITH_BLOCKED) });
        s.on("PATCH /api/app/teams/AA/statuses/c-blocked", { status: {} });
      });
      const user = userEvent.setup();
      await section();
      await screen.findByLabelText("Name of Blocked");
      expect(within(row("Todo")).getByText("Default")).toBeTruthy();
      expect(within(row("Blocked")).queryByText("Default")).toBeNull();
      expect(within(row("Done")).queryByText("Default")).toBeNull(); // alone in its role: nothing to choose
      expect(within(row("Done")).queryByRole("button", { name: /Make .* the default/ })).toBeNull();
      await user.click(within(row("Blocked")).getByRole("button", { name: "Make Blocked the default todo status" }));
      await waitFor(() => expect(server.sent("PATCH /api/app/teams/AA/statuses/c-blocked")).toHaveLength(1));
      expect(server.sent("PATCH /api/app/teams/AA/statuses/c-blocked")[0].body).toEqual({ isDefault: true });
    });
  });

  describe("adding", () => {
    test("each role has an add row: the name is sent with that role", async () => {
      const { server } = open((s) => s.on("POST /api/app/teams/AA/statuses", { status: {} }));
      const user = userEvent.setup();
      await section();
      await user.click(await screen.findByRole("button", { name: "Add in progress status" }));
      await user.type(screen.getByLabelText("New in progress status"), "In review{Enter}");
      await waitFor(() => expect(server.sent("POST /api/app/teams/AA/statuses")).toHaveLength(1));
      expect(server.sent("POST /api/app/teams/AA/statuses")[0].body).toEqual({ name: "In review", role: "in_progress" });
      expect(screen.queryByLabelText("New in progress status")).toBeNull(); // the box closes
    });
    test("Escape or Cancel closes the box with nothing sent; an empty name sends nothing", async () => {
      const { server } = open();
      const user = userEvent.setup();
      await section();
      await user.click(await screen.findByRole("button", { name: "Add done status" }));
      await user.type(screen.getByLabelText("New done status"), "Shipped{Escape}");
      expect(screen.queryByLabelText("New done status")).toBeNull();
      await user.click(screen.getByRole("button", { name: "Add done status" }));
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      await user.click(screen.getByRole("button", { name: "Add done status" }));
      await user.type(screen.getByLabelText("New done status"), "   {Enter}");
      expect(server.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    });
  });

  describe("deleting", () => {
    test("an empty status is deleted after a confirmation, with nothing to move", async () => {
      const { server } = open((s) => s.on("DELETE /api/app/teams/AA/statuses/c-review", { ok: true, deleted: "Review", moved: 0 }));
      const user = userEvent.setup();
      await section();
      await user.click(await screen.findByRole("button", { name: "Delete Review" }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText("Delete Review?")).toBeTruthy();
      expect(within(dialog).getByText("No issue is in it.")).toBeTruthy();
      expect(within(dialog).queryByRole("combobox")).toBeNull();
      await user.click(within(dialog).getByRole("button", { name: "Delete status" }));
      await waitFor(() => expect(server.sent("DELETE /api/app/teams/AA/statuses/c-review")).toHaveLength(1));
      expect(server.sent("DELETE /api/app/teams/AA/statuses/c-review")[0].url).toBe("/api/app/teams/AA/statuses/c-review");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });
    test("a status with issues asks where they go, starting with its own role's default, and sends that as moveTo", async () => {
      const { server } = open((s) => {
        s.on("GET /api/app/teams/AA/statuses", { statuses: statusSettings(WITH_BLOCKED) });
        s.on("DELETE /api/app/teams/AA/statuses/c-blocked", { ok: true, deleted: "Blocked", moved: 1 });
      });
      const user = userEvent.setup();
      await section();
      await user.click(await screen.findByRole("button", { name: "Delete Blocked" }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText("1 issue is in it. Choose where it goes.")).toBeTruthy();
      expect(within(dialog).getByRole("combobox", { name: "Move issues to" }).textContent).toContain("Todo");
      await user.click(within(dialog).getByRole("combobox", { name: "Move issues to" }));
      await user.click(await screen.findByRole("option", { name: "Backlog" }));
      await user.click(within(dialog).getByRole("button", { name: "Delete status" }));
      await waitFor(() => expect(server.sent("DELETE /api/app/teams/AA/statuses/c-blocked")).toHaveLength(1));
      expect(server.sent("DELETE /api/app/teams/AA/statuses/c-blocked")[0].url).toBe("/api/app/teams/AA/statuses/c-blocked?moveTo=c-backlog");
    });
    test("Cancel leaves everything as it was", async () => {
      const { server } = open();
      const user = userEvent.setup();
      await section();
      await user.click(await screen.findByRole("button", { name: "Delete Review" }));
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(server.calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    });
    test("the only status of a required role cannot be deleted, and says why; review can", async () => {
      open();
      await section();
      for (const [name, why] of [["Backlog", "backlog"], ["Todo", "todo"], ["In Progress", "in progress"], ["Done", "done"], ["Canceled", "canceled"]]) {
        const button = (await screen.findByRole("button", { name: `Delete ${name}` })) as HTMLButtonElement;
        expect(button.disabled, name).toBe(true);
        expect(button.title).toBe(`A team needs at least one ${why} status`);
      }
      expect((screen.getByRole("button", { name: "Delete Review" }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  describe("when the server refuses", () => {
    test("its message is shown above the list and the list is not changed", async () => {
      open((s) => s.on("PATCH /api/app/teams/AA/statuses/c-todo", apiError(409, "conflict", 'This team already has a status called "Done"')));
      const user = userEvent.setup();
      const input = (await (await section()).findByLabelText("Name of Todo")) as HTMLInputElement;
      await user.clear(input);
      await user.type(input, "Done{Enter}");
      expect((await screen.findByRole("alert")).textContent).toContain('already has a status called "Done"');
      expect(screen.getByRole("region", { name: "Todo" })).toBeTruthy();
    });
    test("a delete that needs a destination is shown as the server's own words", async () => {
      open((s) => s.on("DELETE /api/app/teams/AA/statuses/c-review", apiError(409, "conflict", "3 issues are in \"Review\". Say which status they move to.")));
      const user = userEvent.setup();
      await section();
      await user.click(await screen.findByRole("button", { name: "Delete Review" }));
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete status" }));
      expect((await screen.findByRole("alert")).textContent).toContain("Say which status they move to");
    });
  });
});
