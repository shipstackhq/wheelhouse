import { describe, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiError, renderApp } from "../../test/harness";
import { initiativeDetail, initiativeSummary } from "../../test/data";

const created = (initiative: unknown) => new Response(JSON.stringify({ initiative }), { status: 201, headers: { "content-type": "application/json" } });

describe("the initiatives list", () => {
  test("each initiative shows its status, health, owner, target, counts and rolled-up progress, nested by level", async () => {
    renderApp("/initiatives", (s) =>
      s.on("GET /api/app/initiatives", {
        initiatives: [
          initiativeSummary({ id: "i1", name: "Enterprise ready", total: 10, done: 4, projectCount: 2, childCount: 1 }),
          initiativeSummary({ id: "i2", parentId: "i1", depth: 2, name: "SSO", status: "planned", health: { derived: null, override: null, value: null }, owner: null, targetDate: null, projectCount: 1 }),
        ],
      }),
    );
    const card = async (name: string) => (await screen.findByText(name, { selector: ".font-semibold" })).closest("a") as HTMLElement;
    const top = await card("Enterprise ready");
    expect(within(top).getByText("active", { selector: ".chip" })).toBeTruthy();
    expect(within(top).getByText("On track")).toBeTruthy();
    expect(top.textContent).toContain("Owned by Ada Lovelace · 2 projects · 1 sub-initiative");
    expect(within(top).getByLabelText("4 of 10 tickets done")).toBeTruthy();
    expect(top.getAttribute("href")).toBe("/initiatives/i1");
    const sub = await card("SSO");
    expect(sub.textContent).toContain("No owner · 1 project");
    expect(sub.textContent).toContain("no target date");
    expect(sub.style.marginLeft).toBe("1.5rem");
    expect(top.style.marginLeft).toBe("0rem");
  });

  test("with none it invites starting one; the sidebar has an Initiatives link", async () => {
    renderApp("/initiatives", (s) => s.on("GET /api/app/initiatives", { initiatives: [] }));
    await screen.findByText(/No initiatives yet/);
    expect(screen.getAllByRole("link", { name: "Initiatives" }).some((a) => a.getAttribute("href") === "/initiatives")).toBe(true);
  });

  test("a new initiative is made from a name, and can go under one that has room; it opens its page", async () => {
    const { server, router } = renderApp("/initiatives", (s) => {
      s.on("GET /api/app/initiatives", {
        initiatives: [
          initiativeSummary({ id: "i1", name: "Top", depth: 1 }),
          initiativeSummary({ id: "i3", parentId: "i1", name: "Deep", depth: 3 }),
          initiativeSummary({ id: "i4", name: "Not mine", canEdit: false }),
        ],
      });
      s.on("POST /api/app/initiatives", created(initiativeDetail({ id: "new1", name: "Goal" })));
      s.on("GET /api/app/initiatives/new1", { initiative: initiativeDetail({ id: "new1", name: "Goal" }) });
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "+ New initiative" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Goal");
    await user.click(screen.getByRole("combobox", { name: "Under" }));
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["Nothing (a top initiative)", "Top"]);
    await user.click(screen.getByRole("option", { name: "Top" }));
    await user.click(screen.getByRole("button", { name: "Create initiative" }));
    await waitFor(() => expect(server.sent("POST /api/app/initiatives")).toHaveLength(1));
    expect(server.sent("POST /api/app/initiatives")[0].body).toEqual({ name: "Goal", description: "", status: "planned", targetDate: null, parentId: "i1" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/initiatives/new1"));
  });

  test("a name is required, and a refusal from the server is shown with the form kept", async () => {
    const { server } = renderApp("/initiatives", (s) => {
      s.on("GET /api/app/initiatives", { initiatives: [] });
      s.on("POST /api/app/initiatives", apiError(400, "invalid", "Initiatives nest at most 3 levels deep"));
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "+ New initiative" }));
    await user.click(screen.getByRole("button", { name: "Create initiative" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/needs a name/);
    expect(server.sent("POST /api/app/initiatives")).toHaveLength(0);
    await user.type(screen.getByRole("textbox", { name: "Name" }), "X");
    await user.click(screen.getByRole("button", { name: "Create initiative" }));
    expect((await screen.findByText(/nest at most 3 levels/)).textContent).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Name" })).toBeTruthy();
  });
});

describe("one initiative", () => {
  const detail = (over = {}) =>
    initiativeDetail({
      id: "i1",
      name: "Enterprise ready",
      description: "Everything big customers ask for",
      total: 8,
      done: 3,
      childCount: 1,
      projectCount: 1,
      path: [{ id: "i0", name: "Company goals" }],
      children: [initiativeSummary({ id: "i2", parentId: "i1", depth: 3, name: "SSO", total: 2, done: 1 })],
      projects: [
        { id: "p1", name: "Launch SSO", status: "active", health: { derived: "on_track", override: null, value: "on_track" }, targetDate: null, total: 4, done: 2, direct: true },
        { id: "p2", name: "Audit log", status: "planned", health: { derived: null, override: null, value: null }, targetDate: null, total: 1, done: 0, direct: false },
      ],
      hidden: { count: 2, total: 3, done: 1 },
      linkable: [{ id: "p9", name: "Billing" }],
      depth: 2,
      ...over,
    });
  const page = (d = detail(), setup: Parameters<typeof renderApp>[1] = () => {}) => renderApp("/initiatives/i1", (s) => (s.on("GET /api/app/initiatives/i1", { initiative: d }), setup(s)));

  test("what it is, the path above, the initiatives below, and the projects: the others only as totals", async () => {
    page();
    await screen.findByRole("heading", { level: 2, name: "Enterprise ready" });
    expect(screen.getByText("Everything big customers ask for")).toBeTruthy();
    expect(within(screen.getByRole("navigation", { name: "Where this sits" })).getByRole("link", { name: "Company goals" }).getAttribute("href")).toBe("/initiatives/i0");
    const below = screen.getByRole("region", { name: "Initiatives below" });
    expect(within(below).getByRole("link", { name: /SSO/ }).getAttribute("href")).toBe("/initiatives/i2");
    const projects = screen.getByRole("region", { name: "Projects" });
    expect(within(projects).getByRole("link", { name: "Launch SSO" }).getAttribute("href")).toBe("/projects/p1");
    expect(within(projects).getByText("through a sub-initiative")).toBeTruthy();
    expect(projects.querySelector("[data-hidden]")!.textContent).toBe("2 other projects of teams you are not in: 1 of 3 tickets done.");
  });

  test("with one hidden project it says so in the singular; with none there is no line, and none at all says so", async () => {
    const { unmount } = page(detail({ hidden: { count: 1, total: 1, done: 0 } }));
    await screen.findByRole("heading", { level: 2, name: "Enterprise ready" });
    expect(document.querySelector("[data-hidden]")!.textContent).toBe("1 other project of teams you are not in: 0 of 1 ticket done.");
    unmount();
    page(detail({ hidden: { count: 0, total: 0, done: 0 }, projects: [] }));
    await screen.findByRole("heading", { level: 2, name: "Enterprise ready" });
    expect(document.querySelector("[data-hidden]")).toBeNull();
    expect(screen.getByText("No projects yet.")).toBeTruthy();
  });

  test("someone who cannot edit sees no edit, delete, add or remove controls", async () => {
    page(detail({ canEdit: false, linkable: [] }));
    await screen.findByRole("heading", { level: 2, name: "Enterprise ready" });
    for (const name of ["Edit", "Delete", "Add initiative", "Add project", "Remove Launch SSO"]) expect(screen.queryByRole("button", { name }), name).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Health" })).toBeNull();
  });

  test("an initiative at the third level offers nothing under it", async () => {
    page(detail({ depth: 3 }));
    await screen.findByRole("heading", { level: 2, name: "Enterprise ready" });
    expect(screen.queryByRole("textbox", { name: "New sub-initiative" })).toBeNull();
    expect(screen.getByText(/nothing more fits under this one/)).toBeTruthy();
  });

  test("editing saves with the version read; a stale version shows the server's refusal", async () => {
    const { server } = page(detail(), (s) => s.on("PATCH /api/app/initiatives/i1", apiError(409, "conflict", "The initiative was changed (version 2, you had 1). Re-read and retry.")));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.clear(screen.getByRole("textbox", { name: "Name" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Enterprise v2");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.sent("PATCH /api/app/initiatives/i1")).toHaveLength(1));
    const body = server.sent("PATCH /api/app/initiatives/i1")[0].body as Record<string, unknown>;
    expect([body.name, body.version, body.status, body.targetDate]).toEqual(["Enterprise v2", 1, "active", "2026-12-31"]);
    expect("parentId" in body).toBe(false);
    expect((await screen.findByRole("alert")).textContent).toMatch(/was changed/);
  });

  test("health: a value sets the override", async () => {
    const { server } = page(detail(), (s) => s.on("PATCH /api/app/initiatives/i1", { initiative: detail() }));
    const user = userEvent.setup();
    const field = await screen.findByRole("combobox", { name: "Health" });
    expect(field.textContent).toContain("Worked out: On track");
    await user.click(field);
    await user.click(await screen.findByRole("option", { name: "Off track" }));
    await waitFor(() => expect(server.sent("PATCH /api/app/initiatives/i1")).toHaveLength(1));
    expect(server.sent("PATCH /api/app/initiatives/i1")[0].body).toEqual({ healthOverride: "off_track", version: 1 });
  });

  test("adding a sub-initiative, adding a project and removing one send what was chosen", async () => {
    const { server } = page(detail(), (s) => {
      s.on("POST /api/app/initiatives", created(initiativeDetail({ id: "i5" })));
      s.on("POST /api/app/initiatives/i1/projects", created(detail()));
      s.on("DELETE /api/app/initiatives/i1/projects/p1", { initiative: detail() });
    });
    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox", { name: "New sub-initiative" }), "Audit");
    await user.click(screen.getByRole("button", { name: "Add initiative" }));
    await waitFor(() => expect(server.sent("POST /api/app/initiatives")).toHaveLength(1));
    expect(server.sent("POST /api/app/initiatives")[0].body).toEqual({ name: "Audit", parentId: "i1" });
    await user.click(screen.getByRole("combobox", { name: "Project to add" }));
    await user.click(await screen.findByRole("option", { name: "Billing" }));
    await user.click(screen.getByRole("button", { name: "Add project" }));
    await waitFor(() => expect(server.sent("POST /api/app/initiatives/i1/projects")).toHaveLength(1));
    expect(server.sent("POST /api/app/initiatives/i1/projects")[0].body).toEqual({ projectId: "p9" });
    expect(screen.queryByRole("button", { name: "Remove Audit log" }), "a project reached through a sub-initiative is removed there").toBeNull();
    await user.click(screen.getByRole("button", { name: "Remove Launch SSO" }));
    await waitFor(() => expect(server.sent("DELETE /api/app/initiatives/i1/projects/p1")).toHaveLength(1));
  });

  test("deleting asks first, says what happens to what is below, and goes up to the parent", async () => {
    const { server, router } = page(detail({ parentId: "i0" }), (s) => {
      s.on("DELETE /api/app/initiatives/i1", { ok: true, moved: 1, unlinked: 1 });
      s.on("GET /api/app/initiatives/i0", { initiative: initiativeDetail({ id: "i0", name: "Company goals" }) });
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("The 1 initiative under it move up a level. The projects stay as they are.");
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(server.sent("DELETE /api/app/initiatives/i1")).toHaveLength(1));
    await waitFor(() => expect(router.state.location.pathname).toBe("/initiatives/i0"));
  });
});
