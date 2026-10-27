import { describe, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiError, renderApp } from "../test/harness";
import { apiKeysPage, key } from "../test/data";

const SECRET = "wh_" + "S3cr3t".repeat(6);

describe("the API keys page", () => {
  test("lists the active keys with name, prefix and when each was used, never a key value", async () => {
    renderApp("/api-keys", (s) =>
      s.on("GET /api/app/keys", apiKeysPage([key({ id: "k1", name: "Ada's laptop", lastUsedAt: new Date().toISOString() }), key({ id: "k2", name: "CI bot", prefix: "wh_zzzzzzz" })])),
    );
    await screen.findByRole("heading", { level: 1, name: "API keys" });
    expect(await screen.findByText("Ada's laptop")).toBeTruthy();
    expect(screen.getByText(/Read · Board · Map · used just now/)).toBeTruthy();
    expect(screen.getByText(/Read · Board · Map · never used/)).toBeTruthy();
    expect(screen.getAllByText("wh_abcdefg…").length).toBe(1);
    expect(document.body.textContent).not.toContain(SECRET);
  });

  test("with no keys it says so", async () => {
    renderApp("/api-keys", (s) => s.on("GET /api/app/keys", apiKeysPage([])));
    await screen.findByText(/No active keys/);
  });

  test("revoked keys stay out of the way until asked for, struck through, with no actions", async () => {
    renderApp("/api-keys", (s) => s.on("GET /api/app/keys", apiKeysPage([key(), key({ id: "k2", name: "Old bot", revokedAt: "2026-10-10T00:00:00.000Z" })])));
    const show = await screen.findByRole("button", { name: "Show revoked keys (1)" });
    expect(screen.queryByText("Old bot")).toBeNull();
    await userEvent.setup().click(show);
    const old = screen.getByText("Old bot");
    expect(old.className).toContain("line-through");
    expect(within(old.closest("li") as HTMLElement).queryByRole("button")).toBeNull();
  });

  const openNew = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole("button", { name: "New key" }));
    return screen.getByRole("dialog");
  };
  const box = (d: HTMLElement, name: string | RegExp) => within(d).getByRole("checkbox", { name }) as HTMLInputElement;

  test("the New key dialog starts with every team ticked, Read, Board and Map ticked, and Read locked", async () => {
    renderApp("/api-keys");
    const d = await openNew(userEvent.setup());
    expect(box(d, "Alpha").checked && box(d, "Beta").checked).toBe(true);
    expect(box(d, /^Read/).checked && box(d, /^Board/).checked && box(d, /^Map/).checked).toBe(true);
    expect(box(d, /^Docs/).checked || box(d, /^Planning/).checked).toBe(false);
    expect(box(d, /^Read/).disabled).toBe(true);
    expect(within(d).getByText("See issues, cycles, projects, the map and docs")).toBeTruthy();
  });

  test("a retired team is not offered: the server refuses a key for it", async () => {
    const { server } = renderApp("/api-keys");
    server.teams = server.teams.map((t) => (t.key === "BB" ? { ...t, retired: true } : t));
    const d = await openNew(userEvent.setup());
    expect(within(d).queryByRole("checkbox", { name: "Beta" })).toBeNull();
    expect(within(d).getByText("Alpha")).toBeTruthy();
  });

  test("Create is disabled without a name or without a team, and says why", async () => {
    renderApp("/api-keys");
    const user = userEvent.setup();
    const d = await openNew(user);
    const create = within(d).getByRole("button", { name: "Create key" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    await user.type(within(d).getByLabelText("Name"), "CI bot");
    expect(create.disabled).toBe(false);
    await user.click(box(d, "Alpha"));
    await user.click(box(d, "Beta"));
    expect(create.disabled).toBe(true);
    expect(within(d).getByText(/Choose at least one team/)).toBeTruthy();
  });

  test("Create sends name, teams and scopes in one request, then the same dialog shows the secret once and the setup command", async () => {
    const created = key({ id: "k9", name: "CI bot", prefix: SECRET.slice(0, 10) });
    const { server } = renderApp("/api-keys", (s) => {
      s.on("POST /api/app/keys", Response.json({ key: created, secret: SECRET }, { status: 201 }));
    });
    const user = userEvent.setup();
    const d = await openNew(user);
    await user.type(within(d).getByLabelText("Name"), "CI bot");
    await user.click(box(d, "Beta"));
    await user.click(box(d, /^Docs/));
    await user.click(within(d).getByRole("button", { name: "Create key" }));
    await screen.findByText(SECRET);
    expect(server.sent("POST /api/app/keys")).toHaveLength(1);
    expect(server.sent("POST /api/app/keys")[0].body).toEqual({ name: "CI bot", teams: ["AA"], scopes: ["read", "board:write", "map:write", "docs:write"] });
    expect(server.sent("POST /api/app/keys")[0].headers["x-csrf-token"]).toBe("csrf-ada");
    expect(within(screen.getByRole("dialog")).getByText(/It won't be shown again/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(SECRET)).toBeNull();
  });

  test("a key the server refuses (too many) is explained in the dialog, with no secret shown", async () => {
    renderApp("/api-keys", (s) => s.on("POST /api/app/keys", apiError(429, "rate_limited", "Too many attempts. Try again in 60 minutes.")));
    const user = userEvent.setup();
    const d = await openNew(user);
    await user.type(within(d).getByLabelText("Name"), "CI bot");
    await user.click(within(d).getByRole("button", { name: "Create key" }));
    expect((await within(d).findByRole("alert")).textContent).toBe("Too many attempts. Try again in 60 minutes.");
  });

  test("each key shows its teams and what it can do; one with no teams says it reaches nothing", async () => {
    renderApp("/api-keys", (s) =>
      s.on("GET /api/app/keys", apiKeysPage([key({ id: "k1", name: "Wide", scopes: ["read", "docs:write"], teams: [{ key: "AA", name: "Alpha" }, { key: "BB", name: "Beta" }] }), key({ id: "k2", name: "Orphan", teams: [] })])),
    );
    const wide = (await screen.findByText("Wide")).closest("li") as HTMLElement;
    expect(within(wide).getByText("AA")).toBeTruthy();
    expect(within(wide).getByText("BB")).toBeTruthy();
    expect(within(wide).getByText(/Read · Docs/)).toBeTruthy();
    expect(within((screen.getByText("Orphan").closest("li")) as HTMLElement).getByText(/reaches nothing/)).toBeTruthy();
  });

  test("Edit opens the form prefilled with the key's teams and scopes, and saves both", async () => {
    const { server } = renderApp("/api-keys", (s) => {
      s.on("GET /api/app/keys", apiKeysPage([key({ id: "k1", name: "Narrow", scopes: ["read", "docs:write"], teams: [{ key: "AA", name: "Alpha" }] })]));
      s.on("PATCH /api/app/keys/k1", { key: key({ id: "k1" }) });
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Actions for Narrow" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const d = screen.getByRole("dialog");
    expect(box(d, "Alpha").checked).toBe(true);
    expect(box(d, "Beta").checked).toBe(false);
    expect(box(d, /^Docs/).checked).toBe(true);
    expect(box(d, /^Board/).checked).toBe(false);
    await user.click(box(d, "Beta"));
    await user.click(box(d, /^Board/));
    await user.click(within(d).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.sent("PATCH /api/app/keys/k1")).toHaveLength(2));
    expect(server.sent("PATCH /api/app/keys/k1").map((r) => r.body)).toEqual([{ scopes: ["read", "board:write", "docs:write"] }, { teams: ["AA", "BB"] }]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("Mark all seen calls the API for that key; Revoke asks first, then does", async () => {
    const { server } = renderApp("/api-keys", (s) => {
      s.on("DELETE /api/app/keys/k1", { ok: true });
      s.on("POST /api/app/keys/mark-all-seen", { ok: true });
    });
    const user = userEvent.setup();
    const menu = async (item: string) => {
      await user.click(await screen.findByRole("button", { name: "Actions for Claude — Ada's laptop" }));
      await user.click(await screen.findByRole("menuitem", { name: item }));
    };
    await menu("Mark all seen");
    await waitFor(() => expect(server.sent("POST /api/app/keys/mark-all-seen")).toHaveLength(1));
    expect(server.sent("POST /api/app/keys/mark-all-seen")[0].body).toEqual({ keyId: "k1" });
    await menu("Revoke");
    expect(server.sent("DELETE /api/app/keys/k1")).toHaveLength(0);
    await user.click(await screen.findByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(server.sent("DELETE /api/app/keys/k1")).toHaveLength(1));
  });

  test("the setup guide carries the commands from the server, and none of them holds a key", async () => {
    renderApp("/api-keys", (s) => s.on("GET /api/app/keys", apiKeysPage([key()], { teamKey: "WH", linkRepo: "/wheelhouse:setup WH" })));
    await screen.findByText("Setup guide and other agents");
    expect(document.body.textContent).toContain("/wheelhouse:setup WH");
    expect(document.body.textContent).toContain("https://wh.example.test/mcp");
    expect(document.body.textContent).not.toMatch(/wh_[A-Za-z0-9]{12,}/);
    expect(screen.getByRole("heading", { name: "Other agents and CI" })).toBeTruthy();
  });
});
