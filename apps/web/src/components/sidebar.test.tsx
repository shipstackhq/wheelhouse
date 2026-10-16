import { describe, expect, test } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "./sidebar";
import { renderIn } from "../test/harness";

const PROJECTS = [
  { key: "AA", name: "Alpha" },
  { key: "BB", name: "Beta" },
  { key: "CC", name: "Gamma" },
];
const sidebar = (over: Partial<React.ComponentProps<typeof Sidebar>> = {}) => (
  <Sidebar projects={PROJECTS} teamName="Analytical Engines" isAdmin={false} profile={<div>the profile</div>} {...over} />
);
const nav = () => screen.getByRole("navigation");
const switcher = () => within(nav()).getByRole("button", { name: /Alpha|Beta|Gamma|Select a project/ });

describe("what the sidebar shows", () => {
  test("a project's sections are grouped under it, with the current one marked and Board only on the exact address", () => {
    renderIn(sidebar(), "/p/AA/docs");
    const links = Object.fromEntries(within(nav()).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")]));
    expect(links).toMatchObject({ Home: "/", Board: "/p/AA", Activity: "/p/AA/activity", Map: "/p/AA/map", Docs: "/p/AA/docs", Decisions: "/p/AA/decisions", Glossary: "/p/AA/glossary", Repos: "/p/AA/repos", Members: "/team", "Agents & API keys": "/agents" });
    expect(screen.getByText("Work")).toBeTruthy();
    expect(screen.getByText("Knowledge")).toBeTruthy();
    expect(screen.getByText("Code")).toBeTruthy();
    expect(within(nav()).getByRole("link", { name: "Docs" }).classList.contains("bg-panel-2")).toBe(true);
    expect(within(nav()).getByRole("link", { name: "Board" }).classList.contains("bg-panel-2")).toBe(false);
    expect(screen.getByText("Analytical Engines")).toBeTruthy();
    expect(screen.getByText("the profile")).toBeTruthy();
  });

  test("with no project open there are no project sections and the switcher invites a choice", () => {
    renderIn(sidebar(), "/team");
    expect(switcher().textContent).toContain("Select a project");
    expect(within(nav()).queryByRole("link", { name: "Board" })).toBeNull();
    expect(within(nav()).getByRole("link", { name: "Members" }).classList.contains("bg-panel-2")).toBe(true);
  });

  test("the Admin section is for administrators", () => {
    const { unmount } = renderIn(sidebar(), "/");
    expect(screen.queryByText("Admin")).toBeNull();
    unmount();
    renderIn(sidebar({ isAdmin: true }), "/");
    expect(screen.getByText("Admin")).toBeTruthy();
    expect(within(nav()).getByRole("link", { name: "Teams" }).getAttribute("href")).toBe("/admin/teams");
    expect(within(nav()).getByRole("link", { name: "Invite a new team" }).getAttribute("href")).toBe("/admin/invites");
  });
});

describe("the project switcher", () => {
  test("opens from the button and with Cmd+K or Ctrl+K, and closes with Escape", async () => {
    const user = userEvent.setup();
    renderIn(sidebar(), "/p/AA");
    expect(screen.queryByPlaceholderText("Search projects…")).toBeNull();
    await user.click(switcher());
    expect(screen.getByPlaceholderText("Search projects…")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByPlaceholderText("Search projects…")).toBeNull();
    await user.keyboard("{Meta>}k{/Meta}");
    expect(screen.getByPlaceholderText("Search projects…")).toBeTruthy();
    await user.keyboard("{Meta>}k{/Meta}");
    expect(screen.queryByPlaceholderText("Search projects…")).toBeNull();
    await user.keyboard("{Control>}k{/Control}");
    expect(screen.getByPlaceholderText("Search projects…")).toBeTruthy();
  });

  test("searching filters by name or key and says when nothing matches", async () => {
    const user = userEvent.setup();
    renderIn(sidebar(), "/p/AA");
    await user.click(switcher());
    await user.keyboard("gam");
    expect(screen.getByRole("button", { name: /Gamma/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Beta/ })).toBeNull();
    await user.clear(screen.getByPlaceholderText("Search projects…"));
    await user.keyboard("bb");
    expect(screen.getByRole("button", { name: /Beta/ })).toBeTruthy();
    await user.clear(screen.getByPlaceholderText("Search projects…"));
    await user.keyboard("zzz");
    expect(screen.getByText("No projects match.")).toBeTruthy();
  });

  test("choosing a project keeps the section you are in", async () => {
    const user = userEvent.setup();
    const { router } = renderIn(sidebar(), "/p/AA/docs");
    await user.click(switcher());
    await user.click(screen.getByRole("button", { name: /Beta/ }));
    expect(router.state.location.pathname).toBe("/p/BB/docs");
    expect(screen.queryByPlaceholderText("Search projects…")).toBeNull();
  });

  test("from a page that is not a project's it goes to the project's board; an unknown section also falls back to the board", async () => {
    const user = userEvent.setup();
    const { router, unmount } = renderIn(sidebar(), "/team");
    await user.click(switcher());
    await user.click(screen.getByRole("button", { name: /Gamma/ }));
    expect(router.state.location.pathname).toBe("/p/CC");
    unmount();
    const second = renderIn(sidebar(), "/p/AA/onboarding"); // not a sidebar section
    await user.click(switcher());
    await user.click(screen.getByRole("button", { name: /Beta/ }));
    expect(second.router.state.location.pathname).toBe("/p/BB");
  });

  test("the keyboard works: arrows move, Enter chooses", async () => {
    const user = userEvent.setup();
    const { router } = renderIn(sidebar(), "/p/AA/map");
    await user.click(switcher());
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowUp}{Enter}");
    expect(router.state.location.pathname).toBe("/p/BB/map");
  });

  test("recent projects come first, under a heading, and viewing a project updates them", async () => {
    localStorage.setItem("wh:recent-projects", JSON.stringify(["CC", "BB"]));
    const user = userEvent.setup();
    renderIn(sidebar(), "/p/AA");
    await user.click(switcher());
    expect(screen.getByText("Recent")).toBeTruthy();
    const order = screen.getAllByRole("button").map((b) => b.textContent ?? "").filter((t) => /Alpha|Beta|Gamma/.test(t) && !t.includes("⌘"));
    expect(order.map((t) => t.replace(/[A-Z]{2}$/, ""))).toEqual(["Alpha", "Gamma", "Beta"]);
    expect(JSON.parse(localStorage.getItem("wh:recent-projects")!)).toEqual(["AA", "CC", "BB"]);
  });

  test("the new project link is in the switcher and closes it", async () => {
    const user = userEvent.setup();
    const { router } = renderIn(sidebar(), "/p/AA");
    await user.click(switcher());
    await user.click(screen.getByRole("link", { name: "+ New project" }));
    expect(router.state.location.pathname).toBe("/projects/new");
    expect(screen.queryByPlaceholderText("Search projects…")).toBeNull();
  });
});

describe("remembering the last project", () => {
  test("viewing a project writes the cookie the Next app also uses", () => {
    renderIn(sidebar(), "/p/BB/docs");
    expect(document.cookie).toContain("wh_last_project=BB");
  });

  test("the logo goes to the last project, or home if it is unknown", () => {
    document.cookie = "wh_last_project=CC; path=/";
    const { unmount } = renderIn(sidebar(), "/team");
    expect(logo().getAttribute("href")).toBe("/p/CC");
    unmount();
    document.cookie = "wh_last_project=GONE; path=/";
    renderIn(sidebar(), "/team");
    expect(logo().getAttribute("href")).toBe("/");
  });
});

const logo = () => screen.getAllByRole("link").find((a) => a.textContent?.includes("Wheelhouse"))!;

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
