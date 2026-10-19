import { describe, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiError, renderApp } from "../../test/harness";
import { projectMembers } from "../../test/data";

const url = "/api/app/projects/AA/members";
const open = (data = projectMembers(), setup: Parameters<typeof renderApp>[1] = () => {}) => renderApp("/p/AA/members", (s) => (s.on(`GET ${url}`, data), setup(s)));
const rowOf = async (name: string) => (await within(await screen.findByRole("main")).findByText(name)).closest("li") as HTMLElement;

describe("the project members page", () => {
  test("lists who can open the project with their roles, marks you, and says whose project it is", async () => {
    open();
    await screen.findByRole("heading", { level: 1, name: "Project members" });
    expect(screen.getByText(/Only the people listed here can open/)).toBeTruthy();
    const ada = await rowOf("Ada Lovelace");
    expect(within(ada).getByText("(you)")).toBeTruthy();
    expect(within(ada).getByText(/workspace owner/)).toBeTruthy();
    expect(within(await rowOf("Alan Turing")).getByText(/alan@example.test/)).toBeTruthy();
  });

  test("an admin can add, change roles and remove; the last admin cannot be removed", async () => {
    open();
    expect(await screen.findByRole("button", { name: "+ Add member" })).toBeTruthy();
    const ada = await rowOf("Ada Lovelace");
    expect((within(ada).getByRole("button", { name: "Leave" }) as HTMLButtonElement).disabled).toBe(true); // the only admin
    expect(within(await rowOf("Grace Hopper")).getByRole("button", { name: "Remove" })).toBeTruthy();
    expect(within(await rowOf("Grace Hopper")).getByRole("combobox", { name: "Role of Grace Hopper" })).toBeTruthy();
  });

  test("a project editor only reads: no add button, roles as plain text, and can only leave", async () => {
    open(projectMembers({ myRole: "editor" }));
    await screen.findByRole("heading", { level: 1, name: "Project members" });
    expect(screen.queryByRole("button", { name: "+ Add member" })).toBeNull();
    expect(screen.getByText(/Ask a project admin/)).toBeTruthy();
    const grace = await rowOf("Grace Hopper");
    expect(within(grace).queryByRole("combobox")).toBeNull();
    expect(within(grace).getByText("editor")).toBeTruthy();
    expect(within(grace).queryByRole("button", { name: "Remove" })).toBeNull();
    expect(within(await rowOf("Ada Lovelace")).getByRole("button", { name: "Leave" })).toBeTruthy(); // anyone may leave their own row
  });

  test("+ Add member lists workspace people not in the project; Add sends the chosen role", async () => {
    const { server } = open(projectMembers(), (s) => {
      s.on(`GET ${url}/addable`, { people: [{ userId: "u9", name: "Edsger Dijkstra", email: "e@example.test", workspaceRole: "member" }] });
      s.on(`POST ${url}`, { member: { userId: "u9", role: "viewer" } });
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "+ Add member" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Edsger Dijkstra")).toBeTruthy();
    await user.click(within(dialog).getByRole("combobox", { name: "Role to give" }));
    await user.click(await screen.findByRole("option", { name: "viewer" }));
    await user.click(within(dialog).getByRole("button", { name: "Add Edsger Dijkstra" }));
    await waitFor(() => expect(server.sent(`POST ${url}`)).toHaveLength(1));
    expect(server.sent(`POST ${url}`)[0].body).toEqual({ userId: "u9", role: "viewer" });
  });

  test("when everyone is already in, it says to invite people from the Workspace page", async () => {
    open(projectMembers(), (s) => s.on(`GET ${url}/addable`, { people: [] }));
    await userEvent.setup().click(await screen.findByRole("button", { name: "+ Add member" }));
    expect(await screen.findByText(/Everyone in the workspace is already in this project/)).toBeTruthy();
  });

  test("changing a role sends a PATCH for that person", async () => {
    const { server } = open(projectMembers(), (s) => s.on(`PATCH ${url}/u2`, { member: { userId: "u2", role: "viewer" } }));
    const user = userEvent.setup();
    await user.click(within(await rowOf("Grace Hopper")).getByRole("combobox", { name: "Role of Grace Hopper" }));
    await user.click(await screen.findByRole("option", { name: "viewer" }));
    await waitFor(() => expect(server.sent(`PATCH ${url}/u2`)).toHaveLength(1));
    expect(server.sent(`PATCH ${url}/u2`)[0].body).toEqual({ role: "viewer" });
  });

  test("Remove asks first, then deletes that person only", async () => {
    const { server } = open(projectMembers(), (s) => s.on(`DELETE ${url}/u3`, { ok: true }));
    const user = userEvent.setup();
    await user.click(within(await rowOf("Alan Turing")).getByRole("button", { name: "Remove" }));
    const ask = await screen.findByRole("alertdialog");
    expect(within(ask).getByText("Remove Alan Turing?")).toBeTruthy();
    await user.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(server.sent(`DELETE ${url}/u3`)).toHaveLength(0);
    await user.click(within(await rowOf("Alan Turing")).getByRole("button", { name: "Remove" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(server.sent(`DELETE ${url}/u3`)).toHaveLength(1));
  });

  test("a refusal is shown in the server's words", async () => {
    open(projectMembers(), (s) => s.on(`PATCH ${url}/u2`, apiError(409, "conflict", "A project needs at least one admin. Name another admin first.")));
    const user = userEvent.setup();
    await user.click(within(await rowOf("Grace Hopper")).getByRole("combobox", { name: "Role of Grace Hopper" }));
    await user.click(await screen.findByRole("option", { name: "admin" }));
    expect((await screen.findByRole("alert")).textContent).toBe("A project needs at least one admin. Name another admin first.");
  });

  test("a project you are not in is a plain not found", async () => {
    renderApp("/p/AA/members", (s) => s.on(`GET ${url}`, apiError(404, "not_found", "Project AA not found")));
    expect(await screen.findByText(/not found/i)).toBeTruthy();
  });
});
