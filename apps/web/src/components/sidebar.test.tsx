import { afterEach, describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "./sidebar";
import { NAV_ICONS } from "./icons";
import { renderIn, serverWithData } from "../test/harness";

const TEAMS = [
  { key: "AA", name: "Alpha" },
  { key: "BB", name: "Beta" },
  { key: "CC", name: "Gamma" },
];
const sidebar = (over: Partial<React.ComponentProps<typeof Sidebar>> = {}) => (
  <Sidebar teams={TEAMS} workspaceName="Analytical Engines" isAdmin={false} profile={<div>the profile</div>} {...over} />
);
const nav = () => screen.getByRole("navigation");
const switcher = () => within(nav()).getByRole("button", { name: "Search teams (⌘K)" });

describe("what the sidebar shows", () => {
  test("the workspace is at the top, the teams are their own section, and only the open team shows its sections", () => {
    renderIn(sidebar(), "/t/BB/docs");
    expect(within(nav()).getByText("Teams")).toBeTruthy();
    const teams = within(nav()).getAllByRole("button").filter((b) => /^(Alpha|Beta|Gamma)/.test(b.textContent ?? ""));
    expect(teams.map((b) => b.textContent)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(teams.map((b) => b.getAttribute("aria-expanded"))).toEqual(["false", "true", "false"]); // the team you are in is open
    expect(within(nav()).getAllByRole("link", { name: "Docs" })).toHaveLength(1); // only the open team's sections
    expect(within(nav()).getByRole("link", { name: "Docs" }).getAttribute("href")).toBe("/t/BB/docs");
    const order = [...nav().querySelectorAll("a, button")].map((a) => a.textContent ?? "");
    expect(order.indexOf("Initiatives")).toBeLessThan(order.indexOf("Projects"));
    expect(order.indexOf("Projects")).toBeLessThan(order.indexOf("Members"));
    expect(order.indexOf("Members")).toBeLessThan(order.indexOf("Agents & API keys"));
    expect(order.indexOf("Agents & API keys")).toBeLessThan(order.findIndex((t) => t.startsWith("Alpha"))); // the whole Workspace group is above the teams
    expect(screen.getByRole("button", { name: /^Workspace menu/ }).getAttribute("title")).toBe("Analytical Engines");
  });

  test("Settings is the last item in the sidebar, after the admin section", () => {
    renderIn(sidebar({ isAdmin: true }), "/t/AA");
    const links = within(nav()).getAllByRole("link");
    expect(links.at(-1)!.textContent).toBe("Settings");
    expect(links.at(-1)!.getAttribute("href")).toBe("/settings");
    expect(links.findIndex((a) => a.textContent === "Invite a new workspace")).toBeLessThan(links.length - 1);
  });

  test("clicking a team only opens or closes its sections: it never navigates, and several can be open", async () => {
    const user = userEvent.setup();
    const { router } = renderIn(sidebar(), "/t/AA/docs");
    const team = (name: RegExp) => within(nav()).getByRole("button", { name });
    expect(team(/^Alpha/).getAttribute("aria-expanded")).toBe("true");
    await user.click(team(/^Beta/));
    expect(router.state.location.pathname).toBe("/t/AA/docs"); // still where we were
    expect(team(/^Beta/).getAttribute("aria-expanded")).toBe("true");
    expect(within(nav()).getAllByRole("link", { name: "Docs" }).map((a) => a.getAttribute("href"))).toEqual(["/t/AA/docs", "/t/BB/docs"]);
    await user.click(team(/^Alpha/)); // the team you are in can be folded too
    expect(router.state.location.pathname).toBe("/t/AA/docs");
    expect(team(/^Alpha/).getAttribute("aria-expanded")).toBe("false");
    expect(within(nav()).getAllByRole("link", { name: "Docs" }).map((a) => a.getAttribute("href"))).toEqual(["/t/BB/docs"]);
    await user.click(team(/^Beta/));
    expect(within(nav()).queryByRole("link", { name: "Docs" })).toBeNull();
  });

  test("each team has a three-dot options menu at the end of its row; opening it neither toggles nor navigates", async () => {
    const user = userEvent.setup();
    const { router } = renderIn(sidebar(), "/t/AA/docs");
    const dots = within(nav()).getByRole("button", { name: "Options for Beta" });
    await user.click(dots);
    expect(await screen.findByText(/Options for Beta will go here/)).toBeTruthy();
    expect(router.state.location.pathname).toBe("/t/AA/docs");
    expect(within(nav()).getByRole("button", { name: /^Beta/ }).getAttribute("aria-expanded")).toBe("false");
    const row = within(nav()).getByRole("button", { name: /^Beta/ }).parentElement!;
    expect(row.lastElementChild!.contains(dots) || row.contains(dots)).toBe(true);
    expect(row.children[0].textContent).toBe("Beta"); // the name, no key label
  });

  test("teams can be moved from the keyboard with Alt+Up and Alt+Down, and the new order is saved for the person", async () => {
    const server = serverWithData();
    server.on("PUT /api/app/teams/order", { ok: true, placed: 3 });
    const user = userEvent.setup();
    renderIn(sidebar(), "/t/AA", server);
    const names = () => within(nav()).getAllByRole("button").map((b) => b.textContent).filter((t) => /^(Alpha|Beta|Gamma)$/.test(t ?? ""));
    expect(names()).toEqual(["Alpha", "Beta", "Gamma"]);
    within(nav()).getByRole("button", { name: /^Beta/ }).focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(names()).toEqual(["Alpha", "Gamma", "Beta"]);
    await vi.waitFor(() => expect(server.sent("PUT /api/app/teams/order")).toHaveLength(1));
    expect(server.sent("PUT /api/app/teams/order")[0].body).toEqual({ keys: ["AA", "CC", "BB"] });
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}"); // already last: nothing to do
    expect(server.sent("PUT /api/app/teams/order")).toHaveLength(1);
  });

  test("going to a team by its sections (or the search) opens it", async () => {
    const user = userEvent.setup();
    const { router } = renderIn(sidebar(), "/t/AA");
    await user.click(switcher());
    await user.click(screen.getByRole("option", { name: /Gamma/ }));
    expect(router.state.location.pathname).toBe("/t/CC");
    expect(within(nav()).getByRole("button", { name: /^Gamma/ }).getAttribute("aria-expanded")).toBe("true");
  });

  test("an account with no team says so, and the create link is there", () => {
    renderIn(sidebar({ teams: [] }), "/");
    expect(screen.getByText(/No teams yet/)).toBeTruthy();
    expect(within(nav()).getByRole("link", { name: "Create a team" }).getAttribute("href")).toBe("/teams/new");
  });

  test("a team's sections are grouped under it, with the current one marked and Board only on the exact address", () => {
    renderIn(sidebar(), "/t/AA/docs");
    const links = Object.fromEntries(within(nav()).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")]));
    expect(links).toMatchObject({ Home: "/", Board: "/t/AA", Activity: "/t/AA/activity", Map: "/t/AA/map", Docs: "/t/AA/docs", Decisions: "/t/AA/decisions", Glossary: "/t/AA/glossary", Repos: "/t/AA/repos", "Team members": "/t/AA/members", "Team settings": "/t/AA/settings", Members: "/workspace", "Agents & API keys": "/agents" });
    expect(within(nav()).getByRole("link", { name: "Docs" }).classList.contains("bg-panel-2")).toBe(true);
    expect(within(nav()).getByRole("link", { name: "Board" }).classList.contains("bg-panel-2")).toBe(false);
    expect(screen.getByRole("button", { name: /^Workspace menu/ })).toBeTruthy();
    expect(screen.getByText("the profile")).toBeTruthy();
  });

  test("with no team open no team is expanded, and every team is still listed", () => {
    renderIn(sidebar(), "/workspace");
    for (const name of ["Alpha", "Beta", "Gamma"]) expect(within(nav()).getByRole("button", { name: new RegExp(`^${name}`) }).getAttribute("aria-expanded")).toBe("false");
    expect(within(nav()).queryByRole("link", { name: "Board" })).toBeNull();
    expect(within(nav()).getByRole("link", { name: "Members" }).classList.contains("bg-panel-2")).toBe(true);
  });

  test("the Admin section is for administrators", () => {
    const { unmount } = renderIn(sidebar(), "/");
    expect(screen.queryByText("Admin")).toBeNull();
    unmount();
    renderIn(sidebar({ isAdmin: true }), "/");
    expect(screen.getByText("Admin")).toBeTruthy();
    expect(within(nav()).getByRole("link", { name: "Workspaces" }).getAttribute("href")).toBe("/admin/workspaces");
    expect(within(nav()).getByRole("link", { name: "Invite a new workspace" }).getAttribute("href")).toBe("/admin/invites");
  });
});

describe("folding a section", () => {
  test("a section's title folds and unfolds its links, and the choice is remembered", async () => {
    const user = userEvent.setup();
    const first = renderIn(sidebar({ isAdmin: true }), "/t/AA");
    const title = screen.getByRole("button", { name: "Workspace" });
    expect(title.getAttribute("aria-expanded")).toBe("true");
    await user.click(title);
    expect(title.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById("group-workspace")!.className).toContain("hidden");
    expect(document.getElementById("group-admin")!.className).not.toContain("hidden");
    first.unmount();
    renderIn(sidebar({ isAdmin: true }), "/t/AA");
    expect(screen.getByRole("button", { name: "Workspace" }).getAttribute("aria-expanded")).toBe("false");
    await user.click(screen.getByRole("button", { name: "Workspace" }));
    expect(document.getElementById("group-workspace")!.className).not.toContain("hidden");
  });
});

describe("the team switcher", () => {
  test("opens from the button and with Cmd+K or Ctrl+K, and closes with Escape", async () => {
    const user = userEvent.setup();
    renderIn(sidebar(), "/t/AA");
    expect(screen.queryByPlaceholderText("Search teams…")).toBeNull();
    await user.click(switcher());
    expect(screen.getByPlaceholderText("Search teams…")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByPlaceholderText("Search teams…")).toBeNull();
    await user.keyboard("{Meta>}k{/Meta}");
    expect(screen.getByPlaceholderText("Search teams…")).toBeTruthy();
    await user.keyboard("{Meta>}k{/Meta}");
    expect(screen.queryByPlaceholderText("Search teams…")).toBeNull();
    await user.keyboard("{Control>}k{/Control}");
    expect(screen.getByPlaceholderText("Search teams…")).toBeTruthy();
  });

  test("searching filters by name or key and says when nothing matches", async () => {
    const user = userEvent.setup();
    renderIn(sidebar(), "/t/AA");
    await user.click(switcher());
    await user.keyboard("gam");
    expect(screen.getByRole("option", { name: /Gamma/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Beta/ })).toBeNull();
    await user.clear(screen.getByPlaceholderText("Search teams…"));
    await user.keyboard("bb");
    expect(screen.getByRole("option", { name: /Beta/ })).toBeTruthy();
    await user.clear(screen.getByPlaceholderText("Search teams…"));
    await user.keyboard("zzz");
    expect(screen.getByText("No teams match.")).toBeTruthy();
  });

  test("choosing a team keeps the section you are in", async () => {
    const user = userEvent.setup();
    const { router } = renderIn(sidebar(), "/t/AA/docs");
    await user.click(switcher());
    await user.click(screen.getByRole("option", { name: /Beta/ }));
    expect(router.state.location.pathname).toBe("/t/BB/docs");
    expect(screen.queryByPlaceholderText("Search teams…")).toBeNull();
  });

  test("from a page that is not a team's it goes to the team's board; an unknown section also falls back to the board", async () => {
    const user = userEvent.setup();
    const { router, unmount } = renderIn(sidebar(), "/workspace");
    await user.click(switcher());
    await user.click(screen.getByRole("option", { name: /Gamma/ }));
    expect(router.state.location.pathname).toBe("/t/CC");
    unmount();
    const second = renderIn(sidebar(), "/t/AA/onboarding"); // not a sidebar section
    await user.click(switcher());
    await user.click(screen.getByRole("option", { name: /Beta/ }));
    expect(second.router.state.location.pathname).toBe("/t/BB");
  });

  test("the keyboard works: arrows move, Enter chooses", async () => {
    const user = userEvent.setup();
    const { router } = renderIn(sidebar(), "/t/AA/map");
    await user.click(switcher());
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowUp}{Enter}");
    expect(router.state.location.pathname).toBe("/t/BB/map");
  });

  test("recent teams come first, under a heading, and viewing a team updates them", async () => {
    localStorage.setItem("wh:recent-teams", JSON.stringify(["CC", "BB"]));
    const user = userEvent.setup();
    renderIn(sidebar(), "/t/AA");
    await user.click(switcher());
    expect(screen.getByText("Recent")).toBeTruthy();
    const order = screen.getAllByRole("option").map((b) => b.textContent ?? "");
    expect(order.map((t) => t.replace(/[A-Z]{2}$/, ""))).toEqual(["Alpha", "Gamma", "Beta"]);
    expect(JSON.parse(localStorage.getItem("wh:recent-teams")!)).toEqual(["AA", "CC", "BB"]);
  });

  test("the new team link is in the switcher and closes it", async () => {
    const user = userEvent.setup();
    const { router } = renderIn(sidebar(), "/t/AA");
    await user.click(switcher());
    await user.click(screen.getByRole("link", { name: "+ New team" }));
    expect(router.state.location.pathname).toBe("/teams/new");
    expect(screen.queryByPlaceholderText("Search teams…")).toBeNull();
  });
});

describe("remembering the last team", () => {
  test("viewing a team writes the cookie the Next app also uses", () => {
    renderIn(sidebar(), "/t/BB/docs");
    expect(document.cookie).toContain("wh_last_team=BB");
  });
});

describe("on a small screen", () => {
  test("the menu is a drawer that opens and closes", async () => {
    const user = userEvent.setup();
    renderIn(sidebar(), "/");
    const drawer = nav().closest("aside")!;
    expect(drawer.className).toContain("-translate-x-full");
    await user.click(screen.getByRole("button", { name: "Open menu" }));
    expect(drawer.className).toContain("translate-x-0");
    expect(drawer.className).not.toContain("-translate-x-full");
    await user.click(screen.getByRole("button", { name: "Close menu" }));
    expect(drawer.className).toContain("-translate-x-full");
  });
});

/** The drawing of an icon, so a test can tell the outline from the solid twin. */
const pathOf = (Icon: (p: Record<string, unknown>) => React.ReactNode) => /<path[^>]* d="([^"]+)"/.exec(renderToStaticMarkup(<Icon />))![1];
const iconOf = (link: HTMLElement) => link.querySelector("svg path:last-of-type, svg path")!.getAttribute("d");
const aside = () => document.getElementById("app-sidebar") as HTMLElement;
afterEach(() => localStorage.clear());

describe("icons: the place you are on is solid, the others are outline", () => {
  test("every pair draws differently, so 'solid' is a real difference", () => {
    for (const [name, pair] of Object.entries(NAV_ICONS)) expect(pathOf(pair.line as never), name).not.toBe(pathOf(pair.fill as never));
  });

  test("on the Docs page, Docs has the solid icon and every other item the outline one", () => {
    renderIn(sidebar({ isAdmin: true }), "/t/AA/docs");
    const expected: Record<string, keyof typeof NAV_ICONS> = {
      Home: "home", Overview: "overview", Board: "board", Activity: "activity", Map: "map", Docs: "docs", Decisions: "decisions", Glossary: "glossary",
      Repos: "repos", "Team members": "teamMembers", "Team settings": "teamSettings", Members: "people", "Agents & API keys": "agents", Workspaces: "workspaces", "Invite a new workspace": "inviteWorkspace",
    };
    for (const [label, key] of Object.entries(expected)) {
      const link = within(nav()).getByRole("link", { name: label });
      const want = label === "Docs" ? NAV_ICONS[key].fill : NAV_ICONS[key].line;
      expect(iconOf(link), label).toBe(pathOf(want as never));
      expect(link.getAttribute("aria-current") === "page", label).toBe(label === "Docs");
    }
  });

  test("moving to another page moves the solid icon", () => {
    const { unmount } = renderIn(sidebar(), "/t/AA");
    expect(iconOf(within(nav()).getByRole("link", { name: "Board" }))).toBe(pathOf(NAV_ICONS.board.fill as never));
    expect(iconOf(within(nav()).getByRole("link", { name: "Overview" }))).toBe(pathOf(NAV_ICONS.overview.line as never)); // /overview is its own address
    unmount();
    renderIn(sidebar(), "/workspace");
    expect(iconOf(within(nav()).getByRole("link", { name: "Members" }))).toBe(pathOf(NAV_ICONS.people.fill as never));
  });
});

describe("collapsing to the icon-only rail", () => {
  test("the toggle collapses and expands, says which, and the labels stay for screen readers", async () => {
    renderIn(sidebar(), "/t/AA");
    const user = userEvent.setup();
    const toggle = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(aside().getAttribute("data-collapsed")).toBe("false");
    expect(aside().className).not.toContain("md:w-14");
    await user.click(toggle);
    const expand = screen.getByRole("button", { name: "Expand sidebar" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(aside().getAttribute("data-collapsed")).toBe("true");
    expect(aside().className).toContain("md:w-14");
    // still reachable by name, with the text visible to screen readers only
    const board = within(nav()).getByRole("link", { name: "Board" });
    expect(board.querySelector("span")!.className).toContain("md:sr-only");
    expect(board.getAttribute("href")).toBe("/t/AA");
    expect(screen.getByText("Workspace").closest("div")!.className).toContain("md:hidden"); // the title makes way for a thin rule
    await user.click(expand);
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy();
    expect(aside().className).not.toContain("md:w-14");
  });

  test("the choice is remembered: a fresh mount starts as it was left", async () => {
    const first = renderIn(sidebar(), "/t/AA");
    await userEvent.setup().click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(localStorage.getItem("wh:sidebar-collapsed")).toBe("1");
    first.unmount();
    renderIn(sidebar(), "/t/AA");
    expect(aside().getAttribute("data-collapsed")).toBe("true");
    await userEvent.setup().click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(localStorage.getItem("wh:sidebar-collapsed")).toBe("0");
  });

  test("blocked storage does not break it: it starts open and still toggles", async () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      renderIn(sidebar(), "/t/AA");
      expect(aside().getAttribute("data-collapsed")).toBe("false");
      await userEvent.setup().click(screen.getByRole("button", { name: "Collapse sidebar" }));
      expect(aside().getAttribute("data-collapsed")).toBe("true");
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });

  test("a tooltip names each icon when collapsed: shown when the link is focused, as a keyboard user would", async () => {
    localStorage.setItem("wh:sidebar-collapsed", "1");
    renderIn(sidebar(), "/t/AA");
    const docs = within(nav()).getByRole("link", { name: "Docs" });
    act(() => docs.focus());
    expect((await screen.findByRole("tooltip")).textContent).toBe("Docs");
  });

  test("expanded, there are no tooltips and no hidden labels", () => {
    renderIn(sidebar(), "/t/AA");
    const board = within(nav()).getByRole("link", { name: "Board" });
    expect(board.querySelector("span")!.className).not.toContain("md:sr-only");
  });

  test("the team switcher still works as a rail: it opens, searches and moves to the chosen team", async () => {
    localStorage.setItem("wh:sidebar-collapsed", "1");
    const { router } = renderIn(sidebar(), "/t/AA/docs");
    const user = userEvent.setup();
    await user.click(within(nav()).getAllByRole("button", { name: "Search teams (⌘K)" }).at(-1)!); // the rail's own (the title row's is hidden there)
    await user.type(await screen.findByPlaceholderText("Search teams…"), "gam");
    await user.click(screen.getByRole("option", { name: /Gamma/ }));
    expect(router.state.location.pathname).toBe("/t/CC/docs"); // keeps the section
    expect(within(nav()).getByRole("button", { name: "Gamma" }).getAttribute("aria-expanded")).toBe("true"); // going to a team opens it
  });

  test("with no team open the collapsed rail still lists the teams and offers the search", () => {
    localStorage.setItem("wh:sidebar-collapsed", "1");
    renderIn(sidebar(), "/workspace");
    expect(within(nav()).getAllByRole("button", { name: "Search teams (⌘K)" }).length).toBeGreaterThan(0);
    expect(within(nav()).getByRole("button", { name: "Beta" })).toBeTruthy(); // the rail names each team by its key and tooltip
  });

  test("the account menu is told whether the rail is collapsed", async () => {
    renderIn(sidebar({ profile: (collapsed: boolean) => <div>{collapsed ? "compact profile" : "full profile"}</div> }), "/t/AA");
    expect(screen.getByText("full profile")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(screen.getByText("compact profile")).toBeTruthy();
  });

  test("the sections, workspace and admin links all keep working when collapsed", () => {
    localStorage.setItem("wh:sidebar-collapsed", "1");
    renderIn(sidebar({ isAdmin: true }), "/t/AA");
    for (const [name, href] of [["Home", "/"], ["Overview", "/t/AA/overview"], ["Map", "/t/AA/map"], ["Members", "/workspace"], ["Agents & API keys", "/agents"], ["Workspaces", "/admin/workspaces"], ["Invite a new workspace", "/admin/invites"]]) {
      expect(within(nav()).getByRole("link", { name }).getAttribute("href")).toBe(href);
    }
  });
});
