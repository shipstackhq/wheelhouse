import { describe, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../../test/harness";
import { githubStatus } from "../../test/data";
import { INTEGRATIONS, type Integration } from "./integrations";
import { matchesSearch } from "./index";

const panel = () => within(screen.getByRole("navigation", { name: "Settings" }));
const main = () => within(screen.getByRole("main"));
/** Render the app and wait for the settings screen (its panel) to be there. */
const open = async (path: string, setup?: Parameters<typeof renderApp>[1]) => {
  const view = renderApp(path, setup);
  await screen.findByRole("navigation", { name: "Settings" });
  return view;
};
const notConnected = (s: { on: (route: string, answer: unknown) => unknown }) => {
  for (const key of ["AA", "BB"]) s.on(`GET /api/app/teams/${key}/repositories/github`, githubStatus({ installations: [] }));
};

describe("the sidebar", () => {
  test("All integrations is first, then each enabled integration", async () => {
    await open("/settings/integrations");
    await panel().findByRole("link", { name: "GitHub" });
    const links = panel().getAllByRole("link").map((a) => a.textContent);
    expect(links.slice(-2)).toEqual(["All integrations", "GitHub"]);
  });

  test("an integration that is not enabled is not in the sidebar", async () => {
    const { server } = await open("/settings/integrations", notConnected);
    await waitFor(() => expect(server.sent("GET /api/app/teams/AA/repositories/github").length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50)); // let the answer land
    expect(panel().getAllByRole("link").map((a) => a.textContent).slice(-1)).toEqual(["All integrations"]);
    expect(panel().queryByRole("link", { name: "GitHub" })).toBeNull();
  });
});

describe("the store", () => {
  test("a card shows icon, name, summary, category and an Enabled badge", async () => {
    await open("/settings/integrations");
    const card = await main().findByRole("link", { name: "GitHub" });
    expect(card.textContent).toContain("Source control");
    expect(card.textContent).toContain(INTEGRATIONS[0].summary);
    expect(card.querySelector("svg")).toBeTruthy();
    await waitFor(() => expect(card.textContent).toContain("Enabled"));
  });

  test("search narrows the cards by name, category or what it does", async () => {
    await open("/settings/integrations");
    const user = userEvent.setup();
    const search = await screen.findByRole("searchbox", { name: "Search integrations" });
    await user.type(search, "zzz");
    expect(await screen.findByText("No integrations match.")).toBeTruthy();
    await user.clear(search);
    await user.type(search, "source control");
    expect(await main().findByRole("link", { name: "GitHub" })).toBeTruthy();
    await user.clear(search);
    await user.type(search, "ci results");
    expect(await main().findByRole("link", { name: "GitHub" })).toBeTruthy();
  });

  test("the Enabled filter hides integrations that are not on", async () => {
    await open("/settings/integrations", notConnected);
    const user = userEvent.setup();
    await main().findByRole("link", { name: "GitHub" });
    await user.click(main().getByRole("button", { name: "Enabled" }));
    await waitFor(() => expect(main().queryByRole("link", { name: "GitHub" })).toBeNull());
    await user.click(main().getByRole("button", { name: "All" }));
    expect(await main().findByRole("link", { name: "GitHub" })).toBeTruthy();
  });

  test("the Enabled filter keeps an enabled integration", async () => {
    await open("/settings/integrations");
    const user = userEvent.setup();
    await user.click(await main().findByRole("button", { name: "Enabled" }));
    await waitFor(() => expect(main().getByRole("link", { name: "GitHub" }).textContent).toContain("Enabled"));
  });

  test("matchesSearch reads name, category and what it does, ignoring case", () => {
    const i = { name: "Slack", category: "Chat", summary: "Messages.", whatItDoes: ["Posts to channels"] } as Integration;
    expect([matchesSearch(i, ""), matchesSearch(i, "SLA"), matchesSearch(i, "chat"), matchesSearch(i, "channels"), matchesSearch(i, "git")]).toEqual([true, true, true, true, false]);
  });
});

describe("an integration's page", () => {
  test("enabled: settings first, details folded behind a Details button", async () => {
    await open("/settings/integrations/github?team=AA");
    await screen.findByRole("heading", { level: 2, name: "Repositories" });
    expect(await main().findByText("Enabled")).toBeTruthy();
    expect(main().queryByText("What it does")).toBeNull();
    expect(main().getByRole("button", { name: "Disable" })).toBeTruthy();
    const details = main().getByRole("button", { name: "Details" });
    expect(details.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(details);
    expect(main().getByText("What it does")).toBeTruthy();
    expect(main().getByText("What it needs")).toBeTruthy();
    expect(main().getByText("Source control")).toBeTruthy();
  });

  test("not enabled: details first with Enable, settings hidden", async () => {
    await open("/settings/integrations/github?team=AA", notConnected);
    expect(await main().findByText("What it does")).toBeTruthy();
    expect(main().getByText("What it needs")).toBeTruthy();
    expect(await main().findByText("Not enabled")).toBeTruthy();
    const enable = main().getByRole("link", { name: "Enable" });
    expect(enable.getAttribute("href")).toContain("/api/github/install?workspace=ae&team=AA");
    expect(main().queryByRole("heading", { level: 2, name: "Repositories" })).toBeNull();
    expect(main().queryByRole("button", { name: "Details" })).toBeNull();
  });

  test("Disable asks first, then disconnects the installation", async () => {
    const { server } = await open("/settings/integrations/github?team=AA", (s) => s.on("DELETE /api/app/teams/AA/repositories/github/1001", { ok: true }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Disable" }));
    expect(server.sent("DELETE /api/app/teams/AA/repositories/github/1001")).toHaveLength(0);
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(server.sent("DELETE /api/app/teams/AA/repositories/github/1001")).toHaveLength(1));
  });

  test("an unknown integration says so", async () => {
    await open("/settings/integrations/nope");
    expect(await screen.findByText(/There is no such integration/)).toBeTruthy();
  });
});
