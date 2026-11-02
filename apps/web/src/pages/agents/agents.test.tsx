import { describe, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ADA, TEAMS, renderApp, type FakeServer } from "../../test/harness";
import { agentsPage, catalogAgent, customAgent } from "../../test/data";

const MEMBER = { ...ADA, role: "member" as const };
const as = (server: FakeServer, role: "owner" | "member", teamRole?: "admin" | "editor") => {
  server.me = { ...ADA, role };
  server.teams = TEAMS.map((t) => ({ ...t, role: teamRole }));
};
const page = (data = agentsPage()) => (s: FakeServer) => s.on("GET /api/app/agents", data);

describe("the Agents page", () => {
  test("lists the catalog and the workspace's own agents as rows, the custom ones marked", async () => {
    renderApp("/agents", page());
    await screen.findByRole("heading", { level: 1, name: "Agents" });
    expect(await screen.findByText("Bram")).toBeTruthy();
    expect(within(screen.getByText("Casey").closest("li")!).getByText("(custom)")).toBeTruthy();
    expect(within(screen.getByText("Bram").closest("li")!).queryByText("(custom)")).toBeNull();
  });

  test("switched off: says so, and sends admins to the setting", async () => {
    renderApp("/agents", page(agentsPage({ enabled: false, catalog: [], workspace: [] })));
    expect(await screen.findByText("Agents are off for this workspace.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "workspace settings" }).getAttribute("href")).toBe("/w/ae/settings/workspace");
    expect(screen.queryByRole("button", { name: "New agent" })).toBeNull();
  });

  test("switched off for a member: no link to the setting", async () => {
    renderApp("/agents", (s) => (page(agentsPage({ enabled: false, catalog: [], workspace: [] }))(s), as(s, "member")));
    await screen.findByText("Agents are off for this workspace.");
    expect(screen.queryByRole("link", { name: "workspace settings" })).toBeNull();
  });

  test("New agent is for workspace admins and team admins only", async () => {
    renderApp("/agents", (s) => (page()(s), as(s, "member", "editor")));
    await screen.findByText("Bram");
    expect(screen.queryByRole("button", { name: "New agent" })).toBeNull();
  });

  test("a team admin creates a team agent from the form: a profile over the schema, sent with the team", async () => {
    const { server } = renderApp("/agents", (s) => (page()(s), as(s, "member", "admin"), s.on("POST /api/app/agents", { agent: customAgent() })));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New agent" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name"), "Dex");
    await user.type(within(dialog).getByLabelText("Role"), "Data engineer");
    await user.type(within(dialog).getByLabelText("Summary (one line for cards)"), "Moves data.");
    await user.type(within(dialog).getByLabelText("When to use it"), "For pipelines.");
    await user.type(within(dialog).getByLabelText("Instructions (markdown)"), "Move data safely.");
    await user.type(within(dialog).getByLabelText("Rules (one per line)"), "Never drop tables{enter}Always back up");
    await user.click(within(dialog).getByRole("combobox", { name: "Tools" }));
    await user.click(await screen.findByRole("option", { name: "Reads only" }));
    await user.click(within(dialog).getByRole("button", { name: "Create agent" }));
    await waitFor(() => expect(server.sent("POST /api/app/agents")).toHaveLength(1));
    const body = server.sent("POST /api/app/agents")[0].body as { profile: Record<string, unknown>; teamKey: string };
    expect(body.teamKey).toBe("AA");
    expect(body.profile).toMatchObject({ schemaVersion: 1, slug: "dex", name: "Dex", role: "Data engineer", toolProfile: "read-only", rules: [{ rule: "Never drop tables" }, { rule: "Always back up" }] });
  });

  test("a workspace admin's agent can be workspace-wide", async () => {
    const { server } = renderApp("/agents", (s) => (page()(s), s.on("POST /api/app/agents", { agent: customAgent() })));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New agent" }));
    const dialog = await screen.findByRole("dialog");
    for (const [label, value] of [["Name", "Dex"], ["Role", "Data"], ["Summary (one line for cards)", "s"], ["When to use it", "d"], ["Instructions (markdown)", "i"]]) await user.type(within(dialog).getByLabelText(label), value);
    expect(within(dialog).getByRole("combobox", { name: "Available to" }).textContent).toContain("Whole workspace");
    await user.click(within(dialog).getByRole("button", { name: "Create agent" }));
    await waitFor(() => expect(server.sent("POST /api/app/agents")).toHaveLength(1));
    expect(server.sent("POST /api/app/agents")[0].body).not.toHaveProperty("teamKey");
  });
});

describe("an agent's page", () => {
  test("shows the profile and the guardrails read-only", async () => {
    renderApp("/agents/casey", page());
    await screen.findByRole("heading", { level: 1, name: /Casey/ });
    expect(screen.getByText("Fix tickets carefully.")).toBeTruthy();
    expect(screen.getByText("Never skip tests")).toBeTruthy();
    expect(await screen.findByText("Stay inside the task.")).toBeTruthy();
    expect(screen.getByText(/Wheelhouse guardrails \(v1\)/)).toBeTruthy();
    expect(screen.getByText(/Made by your workspace, not by Wheelhouse/)).toBeTruthy();
  });

  test("an unknown agent is not found", async () => {
    renderApp("/agents/nobody", page());
    expect(await screen.findByText(/not found/i)).toBeTruthy();
  });

  test("Add to team sends the chosen team's roster add", async () => {
    const { server } = renderApp("/agents/backend", (s) => (page()(s), s.on("POST /api/app/teams/AA/agents", { agent: catalogAgent() })));
    await userEvent.setup().click(await screen.findByRole("button", { name: "Add to team" }));
    await waitFor(() => expect(server.sent("POST /api/app/teams/AA/agents")).toHaveLength(1));
    expect(server.sent("POST /api/app/teams/AA/agents")[0].body).toEqual({ slug: "backend" });
    expect(await screen.findByText("Added to Alpha.")).toBeTruthy();
  });

  test("no Add to team for someone who administers no team", async () => {
    renderApp("/agents/backend", (s) => (page()(s), as(s, "member", "editor")));
    await screen.findByRole("heading", { level: 1, name: /Bram/ });
    expect(screen.queryByRole("button", { name: "Add to team" })).toBeNull();
  });

  test("a team agent can only be added to its own team", async () => {
    renderApp("/agents/casey", page(agentsPage({ workspace: [customAgent({ teamKey: "BB" })] })));
    await screen.findByRole("button", { name: "Add to team" });
    expect(screen.getByRole("combobox", { name: "Team" }).textContent).toBe("Beta");
  });

  test("a catalog agent shows its version, and an admin pins it", async () => {
    const { server } = renderApp("/agents/backend", (s) => (page()(s), s.on("PUT /api/app/agents/catalog/backend/pin", { agent: catalogAgent({ pinnedVersion: 1 }) })));
    expect(await screen.findByText(/Version 1 in use/)).toBeTruthy();
    expect(screen.getByText("(following the latest)")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Pin version 1" }));
    await waitFor(() => expect(server.sent("PUT /api/app/agents/catalog/backend/pin")).toHaveLength(1));
    expect(server.sent("PUT /api/app/agents/catalog/backend/pin")[0].body).toEqual({ version: 1 });
  });

  test("pinned and behind: the new version and its changelog, and Follow latest unpins", async () => {
    const { server } = renderApp("/agents/backend", (s) => {
      page(agentsPage({ catalog: [catalogAgent({ pinnedVersion: 1, latestVersion: 2 })] }))(s);
      s.on("GET /api/app/agents/catalog/backend/versions", { versions: [{ version: 2, summary: "s", changelog: "Sharper rules" }, { version: 1, summary: "s", changelog: "First version" }] });
      s.on("PUT /api/app/agents/catalog/backend/pin", { agent: catalogAgent() });
    });
    expect(await screen.findByText("Version 2 is available: Sharper rules")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Follow latest" }));
    await waitFor(() => expect(server.sent("PUT /api/app/agents/catalog/backend/pin")[0]?.body).toEqual({ version: null }));
  });

  test("a member cannot pin, and a catalog agent has no face or edit", async () => {
    renderApp("/agents/backend", (s) => (page()(s), as(s, "member", "admin")));
    await screen.findByText(/Version 1 in use/);
    for (const name of ["Pin version 1", "Follow latest", "Change face", "Edit"]) expect(screen.queryByRole("button", { name })).toBeNull();
  });

  test("a custom agent: Change face sends only the avatar", async () => {
    const { server } = renderApp("/agents/casey", (s) => (page()(s), s.on("PATCH /api/app/agents/casey", { agent: customAgent() })));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Change face" }));
    await user.click(await screen.findByRole("button", { name: "Shuffle" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.sent("PATCH /api/app/agents/casey")).toHaveLength(1));
    expect(Object.keys(server.sent("PATCH /api/app/agents/casey")[0].body as object)).toEqual(["avatar"]);
  });

  test("Edit opens the form with the profile and saves the whole profile", async () => {
    const { server } = renderApp("/agents/casey", (s) => (page()(s), s.on("PATCH /api/app/agents/casey", { agent: customAgent() })));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText("Name") as HTMLInputElement).value).toBe("Casey");
    await user.clear(within(dialog).getByLabelText("Summary (one line for cards)"));
    await user.type(within(dialog).getByLabelText("Summary (one line for cards)"), "Edited.");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.sent("PATCH /api/app/agents/casey")).toHaveLength(1));
    expect(server.sent("PATCH /api/app/agents/casey")[0].body).toMatchObject({ profile: { slug: "casey", summary: "Edited.", instructions: "Fix tickets carefully." } });
  });

  test("a custom agent the person may only re-face: Change face but no Edit", async () => {
    renderApp("/agents/casey", (s) => (page(agentsPage({ workspace: [customAgent({ can: { edit: false, face: true } })] }))(s), s.me = MEMBER));
    await screen.findByRole("button", { name: "Change face" });
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });
});

describe("a team's agents", () => {
  const roster = (agents = [catalogAgent()]) => (s: FakeServer) => s.on("GET /api/app/teams/AA/agents", { agents });

  test("lists the roster with the Use in Claude Code box", async () => {
    renderApp("/t/AA/agents", roster());
    expect(await screen.findByText("Bram")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Use in Claude Code" })).toBeTruthy();
    expect(screen.getByText("/wheelhouse:agents")).toBeTruthy();
    expect(screen.getByText(/use wh-backend to/)).toBeTruthy();
  });

  test("Add lists what is not on the roster yet and adds the chosen agent", async () => {
    const { server } = renderApp("/t/AA/agents", (s) => (roster()(s), s.on("POST /api/app/teams/AA/agents", { agent: customAgent() })));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: "Add Bram" })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Add Casey" }));
    await waitFor(() => expect(server.sent("POST /api/app/teams/AA/agents")[0]?.body).toEqual({ slug: "casey" }));
  });

  test("Remove asks first, then removes that agent from the roster", async () => {
    const { server } = renderApp("/t/AA/agents", (s) => (roster()(s), s.on("DELETE /api/app/teams/AA/agents/backend", { ok: true })));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Remove Bram" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(server.sent("DELETE /api/app/teams/AA/agents/backend")).toHaveLength(1));
  });

  test("Learnings lists what the team has taught an agent, and Delete removes one", async () => {
    const { server } = renderApp("/t/AA/agents", (s) => {
      roster()(s);
      s.on("GET /api/app/teams/AA/agents/backend/learnings", { learnings: [{ id: "l1", note: "This team keeps tests next to source", createdAt: "2026-10-20T00:00:00.000Z" }], cap: 20 });
      s.on("DELETE /api/app/teams/AA/agents/backend/learnings/l1", { ok: true });
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Learnings of Bram" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("This team keeps tests next to source")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: /^Delete:/ }));
    await waitFor(() => expect(server.sent("DELETE /api/app/teams/AA/agents/backend/learnings/l1")).toHaveLength(1));
  });

  test("an editor only reads: no Add, no Remove", async () => {
    renderApp("/t/AA/agents", (s) => (roster()(s), as(s, "member", "editor")));
    await screen.findByText("Bram");
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove Bram" })).toBeNull();
  });

  test("a team admin who is not a workspace admin can add and remove", async () => {
    renderApp("/t/AA/agents", (s) => (roster()(s), as(s, "member", "admin")));
    expect(await screen.findByRole("button", { name: "Add" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove Bram" })).toBeTruthy();
  });

  test("switched off: the roster says so and offers nothing", async () => {
    renderApp("/t/AA/agents", (s) => (roster([])(s), s.on("GET /api/app/agents", agentsPage({ enabled: false, catalog: [], workspace: [] }))));
    expect(await screen.findByText("Agents are off for this workspace.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  });

  test("the team nav links to it", async () => {
    renderApp("/t/AA/agents", roster());
    expect((await screen.findAllByRole("link", { name: "Agents" })).some((l) => l.getAttribute("href") === "/w/ae/t/AA/agents")).toBe(true);
  });
});

describe("the workspace Agents setting", () => {
  test("the switch shows the state and turns agents off", async () => {
    const { server } = renderApp("/settings/workspace", (s) => s.on("PATCH /api/app/workspace/settings", { settings: { agentsEnabled: false } }));
    const box = (await screen.findByRole("checkbox", { name: /Agents/ })) as HTMLInputElement;
    expect(box.checked).toBe(true);
    await userEvent.setup().click(box);
    await waitFor(() => expect(server.sent("PATCH /api/app/workspace/settings")).toHaveLength(1));
    expect(server.sent("PATCH /api/app/workspace/settings")[0].body).toEqual({ agentsEnabled: false });
  });

  test("members do not see it", async () => {
    renderApp("/settings/workspace", (s) => (s.me = MEMBER));
    await screen.findByRole("heading", { level: 1, name: "General" });
    expect(screen.queryByRole("checkbox", { name: /Agents/ })).toBeNull();
  });
});
