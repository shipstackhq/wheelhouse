import { describe, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TeamProjectOption } from "@wheelhouse/api-client";
import { renderApp, type FakeServer } from "../../test/harness";
import { board as makeBoard, detail, ticket } from "../../test/data";

const PROJECTS: TeamProjectOption[] = [
  { id: "p1", name: "Launch SSO", status: "active", milestones: [{ id: "m1", name: "Beta" }, { id: "m2", name: "GA" }] },
  { id: "p2", name: "Plain project", status: "planned", milestones: [] },
];
const withProjects = () =>
  makeBoard("AA", {
    projects: PROJECTS,
    tickets: [
      ticket({ number: 1, title: "Write the plan", columnId: "c-backlog" }),
      ticket({ number: 2, title: "Build the board", columnId: "c-todo", projectId: "p1", milestoneId: "m1" }),
      ticket({ number: 3, title: "Fix the crash", columnId: "c-todo", projectId: "p2" }),
    ],
  });
const open = async (path = "/t/AA", setup: (s: FakeServer) => unknown = () => {}) => {
  const r = renderApp(path, (s) => {
    s.on("GET /api/app/teams/AA/board", withProjects());
    setup(s);
  });
  await screen.findByText("Build the board");
  return r;
};

describe("projects on the board", () => {
  test("a card in a project carries a chip with the project's name; a card in none has no chip", async () => {
    await open();
    const chip = (title: string) => (screen.getByText(title).closest("[data-ticket]") as HTMLElement).querySelector("[data-project-chip]") as HTMLElement | null;
    expect(chip("Build the board")!.textContent?.trim()).toBe("Launch SSO");
    expect(chip("Build the board")!.getAttribute("title")).toBe("Project: Launch SSO");
    expect(chip("Fix the crash")!.getAttribute("title")).toBe("Project: Plain project");
    expect(chip("Write the plan")).toBeNull();
  });

  test("with no projects there is no chip at all", async () => {
    renderApp("/t/AA");
    await screen.findByText("Write the plan");
    expect(document.querySelectorAll("[data-project-chip]")).toHaveLength(0);
  });
});

describe("the Project and Milestone fields of a ticket", () => {
  const T = () => withProjects().tickets.find((t) => t.ref === "AA-2")!; // in Launch SSO, milestone Beta
  const field = (d: HTMLElement, label: string) => within(d).getByText(label, { selector: "span.label" }).parentElement as HTMLElement;
  const pick = async (user: ReturnType<typeof userEvent.setup>, d: HTMLElement, label: string, option: string) => {
    await user.click(within(field(d, label)).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: option }));
  };
  const openTicket = async (over: Partial<ReturnType<typeof T>> = {}) => {
    const r = await open("/t/AA?t=AA-2", (s) => {
      s.on("GET /api/app/tickets/AA-2", detail({ ...T(), ...over }));
      s.on("PATCH /api/app/tickets/AA-2", { ticket: T() });
    });
    const d = await screen.findByRole("dialog");
    await within(d).findByRole("textbox", { name: "Title" });
    return { ...r, d };
  };

  test("they show the ticket's project and milestone, and offer the team's projects and that project's milestones", async () => {
    const { d } = await openTicket();
    const user = userEvent.setup();
    expect(within(field(d, "Project")).getByRole("combobox").textContent).toContain("Launch SSO");
    expect(within(field(d, "Milestone")).getByRole("combobox").textContent).toContain("Beta");
    await user.click(within(field(d, "Project")).getByRole("combobox"));
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["No project", "Launch SSO", "Plain project"]);
    await user.keyboard("{Escape}");
    await user.click(within(field(d, "Milestone")).getByRole("combobox"));
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["No milestone", "Beta", "GA"]);
  });

  test("choosing saves the id with the ticket's version; No project and No milestone save null", async () => {
    const { server, d } = await openTicket();
    const user = userEvent.setup();
    await pick(user, d, "Milestone", "GA");
    await waitFor(() => expect(server.sent("PATCH /api/app/tickets/AA-2")).toHaveLength(1));
    expect(server.sent("PATCH /api/app/tickets/AA-2")[0].body).toEqual({ milestoneId: "m2", version: 1 });
    await pick(user, d, "Milestone", "No milestone");
    await waitFor(() => expect(server.sent("PATCH /api/app/tickets/AA-2")).toHaveLength(2));
    expect(server.sent("PATCH /api/app/tickets/AA-2")[1].body).toEqual({ milestoneId: null, version: 1 });
    await pick(user, d, "Project", "Plain project");
    await waitFor(() => expect(server.sent("PATCH /api/app/tickets/AA-2")).toHaveLength(3));
    expect(server.sent("PATCH /api/app/tickets/AA-2")[2].body).toEqual({ projectId: "p2", version: 1 });
    await pick(user, d, "Project", "No project");
    await waitFor(() => expect(server.sent("PATCH /api/app/tickets/AA-2")).toHaveLength(4));
    expect(server.sent("PATCH /api/app/tickets/AA-2")[3].body).toEqual({ projectId: null, version: 1 });
  });

  test("a project with no milestones, or a ticket in no project, shows no Milestone field", async () => {
    const a = await openTicket({ projectId: "p2", milestoneId: null });
    expect(within(a.d).queryByText("Milestone", { selector: "span.label" })).toBeNull();
    expect(within(field(a.d, "Project")).getByRole("combobox").textContent).toContain("Plain project");
    a.unmount();
    const b = await openTicket({ projectId: null, milestoneId: null });
    expect(within(b.d).queryByText("Milestone", { selector: "span.label" })).toBeNull();
    expect(within(field(b.d, "Project")).getByRole("combobox").textContent).toContain("No project");
  });

  test("a team that takes part in no project, and a ticket in none, does not show the field", async () => {
    renderApp("/t/AA?t=AA-2", (s) => s.on("GET /api/app/tickets/AA-2", detail(ticket({ number: 2, title: "Build the board", columnId: "c-todo" }))));
    const d = await screen.findByRole("dialog");
    await within(d).findByRole("textbox", { name: "Title" });
    expect(within(d).queryByText("Project", { selector: "span.label" })).toBeNull();
  });
});
