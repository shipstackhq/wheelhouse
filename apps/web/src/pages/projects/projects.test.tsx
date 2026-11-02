import { describe, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiError, renderApp } from "../../test/harness";
import { projectDetail, projectSummary } from "../../test/data";

const open = (path: string, setup: Parameters<typeof renderApp>[1] = () => {}) => renderApp(path, setup);
const created = (project: unknown) => new Response(JSON.stringify({ project }), { status: 201, headers: { "content-type": "application/json" } });

describe("the projects list", () => {
  test("each project shows its status, health, lead, dates, teams and how much is done; active ones come as the server ordered them", async () => {
    open("/projects", (s) =>
      s.on("GET /api/app/projects", {
        projects: [
          projectSummary({ id: "p1", name: "Launch SSO", total: 10, done: 4, teamCount: 2 }),
          projectSummary({ id: "p2", name: "Old migration", status: "completed", health: { derived: null, override: null, value: null }, leadUser: null, teamCount: 1, total: 3, done: 3, startDate: null, targetDate: "2026-09-30" }),
          projectSummary({ id: "p3", name: "Shaky", priority: "urgent", health: { derived: "on_track", override: "at_risk", value: "at_risk" } }),
        ],
      }),
    );
    const card = async (name: string) => (await screen.findByText(name, { selector: ".font-semibold" })).closest("a") as HTMLElement;
    const sso = await card("Launch SSO");
    expect(within(sso).getByText("active", { selector: ".chip" })).toBeTruthy();
    expect(within(sso).getByText("On track")).toBeTruthy();
    expect(sso.textContent).toContain("Led by Ada Lovelace · 2 teams");
    expect(within(sso).getByLabelText("4 of 10 issues done")).toBeTruthy();
    expect(sso.getAttribute("href")).toBe("/w/ae/projects/p1");
    expect(sso.querySelector("[data-priority-chip]")).toBeNull(); // no priority is not worth a chip on the list
    expect((await card("Shaky")).querySelector("[data-priority-chip]")!.textContent).toBe("Urgent");
    const old = await card("Old migration");
    expect(within(old).getByText("completed", { selector: ".chip" })).toBeTruthy();
    expect(within(old).queryByText(/On track|At risk|Off track/)).toBeNull();
    expect(old.textContent).toContain("No lead · 1 team");
    expect(old.textContent).toContain("target");
    expect(within(await card("Shaky")).getByText("(set)")).toBeTruthy();
  });

  test("with none it says a project appears for the people on a team that takes part", async () => {
    open("/projects", (s) => s.on("GET /api/app/projects", { projects: [] }));
    await screen.findByText(/No projects yet/);
  });

  test("a new project is made from a name, a lead team you can edit and the other teams, and opens its page", async () => {
    const { server, router } = open("/projects", (s) => {
      s.on("GET /api/app/projects", { projects: [] });
      s.on("POST /api/app/projects", created(projectDetail({ id: "new1", name: "Launch" })));
      s.on("GET /api/app/projects/new1", { project: projectDetail({ id: "new1", name: "Launch" }) });
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "+ New project" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Launch");
    await user.click(screen.getByLabelText("Beta"));
    await user.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(server.sent("POST /api/app/projects")).toHaveLength(1));
    expect(server.sent("POST /api/app/projects")[0].body).toEqual({ name: "Launch", description: "", status: "planned", priority: "none", startDate: null, targetDate: null, leadTeam: "AA", teams: ["BB"] });
    await waitFor(() => expect(router.state.location.pathname).toBe("/w/ae/projects/new1"));
  });

  test("a project without a name cannot be sent; a target before the start is said; a refusal is shown and the form stays", async () => {
    const { server } = open("/projects", (s) => {
      s.on("GET /api/app/projects", { projects: [] });
      s.on("POST /api/app/projects", apiError(404, "not_found", "Team AA not found"));
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "+ New project" }));
    await user.click(screen.getByRole("button", { name: "Create project" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/needs a name and a lead team/);
    expect(server.sent("POST /api/app/projects")).toHaveLength(0);
    await user.type(screen.getByRole("textbox", { name: "Name" }), "X");
    await user.type(screen.getByLabelText("Start date"), "2026-12-01");
    await user.type(screen.getByLabelText("Target date"), "2026-11-01");
    expect((await screen.findByRole("alert")).textContent).toMatch(/before the start date/);
    await user.clear(screen.getByLabelText("Target date"));
    await user.click(screen.getByRole("button", { name: "Create project" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Team AA not found/);
    expect(screen.getByRole("textbox", { name: "Name" })).toBeTruthy();
  });

  test("the sidebar has a Projects link, and the page is the workspace's, not a team's", async () => {
    open("/projects", (s) => s.on("GET /api/app/projects", { projects: [] }));
    await screen.findByText(/No projects yet/);
    expect(screen.getAllByRole("link", { name: "Projects" }).some((a) => a.getAttribute("href") === "/w/ae/projects")).toBe(true);
  });
});

describe("one project", () => {
  const detail = (over = {}) =>
    projectDetail({
      id: "p1",
      name: "Launch SSO",
      description: "Single sign-on for everyone",
      total: 6,
      done: 2,
      teamCount: 3,
      milestones: [
        { id: "m1", name: "Beta", description: "", targetDate: "2026-11-20", position: 1000, total: 3, done: 1 },
        { id: "m2", name: "GA", description: "", targetDate: null, position: 2000, total: 1, done: 0 },
      ],
      teams: [
        {
          key: "AA", name: "Alpha", role: "admin", lead: true, total: 2, done: 1,
          issues: [
            { ref: "AA-1", title: "Add the button", priority: "high", status: "Done", done: true, milestoneId: "m1" },
            { ref: "AA-2", title: "Wire the callback", priority: "medium", status: "Todo", done: false, milestoneId: null },
          ],
        },
      ],
      others: { count: 2, total: 4, done: 1 },
      addableTeams: [{ key: "BB", name: "Beta" }],
      ...over,
    });
  const page = (d = detail(), setup: Parameters<typeof renderApp>[1] = () => {}) => renderApp("/projects/p1", (s) => (s.on("GET /api/app/projects/p1", { project: d }), setup(s)));

  test("what it is, how it is going, the milestones with their counts, the viewer's own teams with issues, and the others only as totals", async () => {
    page();
    await screen.findByRole("heading", { level: 2, name: "Launch SSO" });
    expect(screen.getByText("Single sign-on for everyone")).toBeTruthy();
    const props = screen.getByRole("region", { name: "Properties" });
    expect(within(props).getByText("Ada Lovelace")).toBeTruthy();
    expect(within(props).getByText("Primary team: Alpha")).toBeTruthy();
    expect(within(props).getByText("2 of 6 issues done")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Resources" }).textContent).toContain("Alpha");
    const ms = screen.getByRole("region", { name: "Milestones" });
    expect(within(ms).getAllByRole("listitem").map((li) => li.textContent?.replace(/UpDownRenameDelete/g, ""))).toEqual(["BetaNov 20, 20261 of 3 done", "GA0 of 1 done"]);
    const teams = screen.getByRole("region", { name: "Teams" });
    expect(within(teams).getByText("lead team")).toBeTruthy();
    expect(within(teams).getByRole("link", { name: /AA-2/ }).getAttribute("href")).toBe("/w/ae/t/AA?t=AA-2");
    expect(within(teams).getAllByText("Beta").length).toBeGreaterThan(0); // a milestone chip on the issue in it
    expect(screen.getByRole("region", { name: "Resources" }).querySelector("[data-others]")!.textContent).toBe("2 teams you are not in: 1 of 4 issues done.");
    expect(teams.textContent).not.toMatch(/BB|Beta team/);
  });

  test("the priority is a pill in the properties, with no priority shown as such", async () => {
    const { unmount } = page(detail({ priority: "high" }));
    await screen.findByRole("heading", { level: 2, name: "Launch SSO" });
    expect(within(screen.getByRole("region", { name: "Properties" })).getByText("High")).toBeTruthy();
    unmount();
    page(detail());
    await screen.findByRole("heading", { level: 2, name: "Launch SSO" });
    expect(within(screen.getByRole("region", { name: "Properties" })).getByText("No priority")).toBeTruthy();
  });

  test("priority: the pill opens a menu, and a pick is saved with the version the page was read at", async () => {
    const { server } = page(detail({ priority: "low" }), (s) => s.on("PATCH /api/app/projects/p1", { project: detail({ priority: "urgent" }) }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Priority: Low" }));
    await user.click(await screen.findByRole("menuitem", { name: "Urgent" }));
    await waitFor(() => expect(server.sent("PATCH /api/app/projects/p1")).toHaveLength(1));
    expect(server.sent("PATCH /api/app/projects/p1")[0].body).toEqual({ priority: "urgent", version: 1 });
  });

  test("picking the priority it already has sends nothing", async () => {
    const { server } = page(detail({ priority: "high" }), (s) => s.on("PATCH /api/app/projects/p1", { project: detail() }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Priority: High" }));
    await user.click(await screen.findByRole("menuitem", { name: "High" }));
    expect(server.sent("PATCH /api/app/projects/p1")).toHaveLength(0);
  });

  test("the edit form does not carry the priority, so saving it cannot overwrite a change made from the pill", async () => {
    const { server } = page(detail({ priority: "high" }), (s) => s.on("PATCH /api/app/projects/p1", { project: detail() }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    expect(screen.queryByRole("combobox", { name: "Priority" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.sent("PATCH /api/app/projects/p1")).toHaveLength(1));
    expect("priority" in (server.sent("PATCH /api/app/projects/p1")[0].body as object)).toBe(false);
  });

  test("an unassigned lead is a pill with a person icon and the words Lead not assigned", async () => {
    page(detail({ leadUser: null }));
    await screen.findByRole("heading", { level: 2, name: "Launch SSO" });
    expect(within(screen.getByRole("region", { name: "Properties" })).getByText("Lead not assigned")).toBeTruthy();
  });

  test("with one other team it says so in the singular; with none there is no line", async () => {
    const { unmount } = page(detail({ others: { count: 1, total: 1, done: 0 } }));
    await screen.findByRole("heading", { level: 2, name: "Launch SSO" });
    expect(document.querySelector("[data-others]")!.textContent).toBe("1 team you are not in: 0 of 1 issue done.");
    unmount();
    page(detail({ others: { count: 0, total: 0, done: 0 } }));
    await screen.findByRole("heading", { level: 2, name: "Launch SSO" });
    expect(document.querySelector("[data-others]")).toBeNull();
  });

  test("someone who cannot edit sees no edit, delete, milestone or team controls", async () => {
    page(detail({ canEdit: false, canAdmin: false, addableTeams: [], teams: [{ key: "AA", name: "Alpha", role: "viewer", lead: true, total: 0, done: 0, issues: [] }] }));
    await screen.findByRole("heading", { level: 2, name: "Launch SSO" });
    for (const name of ["More actions", "Edit", "Delete", "Add milestone", "Bring in"]) expect(screen.queryByRole("button", { name }), name).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Health" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Priority/ })).toBeNull(); // the priority is shown, not a menu
    expect(screen.queryByRole("textbox", { name: "New milestone" })).toBeNull();
  });

  test("editing saves the fields with the version the page was read at; a stale version shows the server's refusal", async () => {
    const { server } = page(detail(), (s) => s.on("PATCH /api/app/projects/p1", apiError(409, "conflict", "The project was changed (version 2, you had 1). Re-read and retry.")));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    await user.clear(screen.getByRole("textbox", { name: "Name" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Launch SSO v2");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.sent("PATCH /api/app/projects/p1")).toHaveLength(1));
    const body = server.sent("PATCH /api/app/projects/p1")[0].body as Record<string, unknown>;
    expect([body.name, body.version, body.status, body.targetDate]).toEqual(["Launch SSO v2", 1, "active", "2026-12-15"]);
    expect("leadTeam" in body).toBe(false);
    expect((await screen.findByRole("alert")).textContent).toMatch(/was changed/);
  });

  test("health: Worked out clears the override, a value sets it", async () => {
    const { server } = page(detail({ health: { derived: "on_track", override: null, value: "on_track" } }), (s) => s.on("PATCH /api/app/projects/p1", { project: detail() }));
    const user = userEvent.setup();
    const field = await screen.findByRole("combobox", { name: "Health" });
    expect(field.textContent).toContain("Worked out: On track");
    await user.click(field);
    await user.click(await screen.findByRole("option", { name: "At risk" }));
    await waitFor(() => expect(server.sent("PATCH /api/app/projects/p1")).toHaveLength(1));
    expect(server.sent("PATCH /api/app/projects/p1")[0].body).toEqual({ healthOverride: "at_risk", version: 1 });
  });

  const milestoneHandlers: NonNullable<Parameters<typeof renderApp>[1]> = (s) => {
    s.on("POST /api/app/projects/p1/milestones", created(detail()));
    s.on("PATCH /api/app/projects/p1/milestones/m2", { project: detail() });
    s.on("DELETE /api/app/projects/p1/milestones/m1", { project: detail() });
  };

  test("milestones: a new one is sent with its name and date", async () => {
    const { server } = page(detail(), milestoneHandlers);
    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox", { name: "New milestone" }), "Pilot");
    await user.type(screen.getByLabelText("Milestone date"), "2026-12-01");
    await user.click(screen.getByRole("button", { name: "Add milestone" }));
    await waitFor(() => expect(server.sent("POST /api/app/projects/p1/milestones")).toHaveLength(1));
    expect(server.sent("POST /api/app/projects/p1/milestones")[0].body).toEqual({ name: "Pilot", targetDate: "2026-12-01" });
  });

  test("milestones: the first cannot move up, the last cannot move down, and a move sends its new place", async () => {
    const { server } = page(detail(), milestoneHandlers);
    const user = userEvent.setup();
    expect((await screen.findByRole("button", { name: "Move Beta up" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Move GA down" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Move GA up" }));
    await waitFor(() => expect(server.sent("PATCH /api/app/projects/p1/milestones/m2")).toHaveLength(1));
    expect(server.sent("PATCH /api/app/projects/p1/milestones/m2")[0].body).toEqual({ index: 0 });
  });

  test("milestones: deleting one asks first and says its issues stay in the project", async () => {
    const { server } = page(detail(), milestoneHandlers);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Delete Beta" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("Its 3 issues stay in the project, in no milestone.");
    expect(server.sent("DELETE /api/app/projects/p1/milestones/m1")).toHaveLength(0);
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(server.sent("DELETE /api/app/projects/p1/milestones/m1")).toHaveLength(1));
  });

  const twoTeams = () =>
    detail({
      teams: [
        { key: "AA", name: "Alpha", role: "admin", lead: true, total: 0, done: 0, issues: [] },
        { key: "BB", name: "Beta", role: "editor", lead: false, total: 2, done: 0, issues: [] },
      ],
      others: { count: 0, total: 0, done: 0 },
      addableTeams: [{ key: "CC", name: "Gamma" }],
    });

  test("bringing a team in sends its key", async () => {
    const two = twoTeams();
    const { server } = page(two, (s) => s.on("POST /api/app/projects/p1/teams", created(two)));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("combobox", { name: "Team to bring in" }));
    await user.click(await screen.findByRole("option", { name: "Gamma (CC)" }));
    await user.click(screen.getByRole("button", { name: "Bring in" }));
    await waitFor(() => expect(server.sent("POST /api/app/projects/p1/teams")).toHaveLength(1));
    expect(server.sent("POST /api/app/projects/p1/teams")[0].body).toEqual({ team: "CC" });
  });

  test("the lead team cannot be taken out", async () => {
    page(twoTeams());
    expect(await screen.findByRole("button", { name: "Take Beta out" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Take Alpha out" })).toBeNull();
  });

  test("taking a team out is refused with its issues, and then done on request", async () => {
    let calls = 0;
    const { server } = page(twoTeams(), (s) => s.on("DELETE /api/app/projects/p1/teams/BB", () => (++calls === 1 ? apiError(409, "conflict", "Beta has 2 issues in this project. Release them with the team, or move them out first.") : { ok: true, released: 2 })));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Take Beta out" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("Beta has 2 issues in this project");
    await user.click(within(confirm).getByRole("button", { name: "Release and take out" }));
    await waitFor(() => expect(server.sent("DELETE /api/app/projects/p1/teams/BB?releaseIssues=1")).toHaveLength(1));
    expect(server.calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual(["/api/app/projects/p1/teams/BB", "/api/app/projects/p1/teams/BB?releaseIssues=1"]);
  });

  test("deleting asks first, says the issues stay on their boards, and goes back to the list", async () => {
    const { server, router } = page(detail(), (s) => {
      s.on("DELETE /api/app/projects/p1", { ok: true, released: 6 });
      s.on("GET /api/app/projects", { projects: [] });
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("Its 6 issues stay on their boards, in no project.");
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(server.sent("DELETE /api/app/projects/p1")).toHaveLength(1));
    await waitFor(() => expect(router.state.location.pathname).toBe("/w/ae/projects"));
  });

  test("a project the person cannot see is not found", async () => {
    renderApp("/projects/p9", (s) => s.on("GET /api/app/projects/p9", apiError(404, "not_found", "Project not found")));
    await screen.findByRole("heading", { name: /not found/i });
  });
});
