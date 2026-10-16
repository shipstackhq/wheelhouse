import { describe, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiError, renderApp } from "../test/harness";
import { agentsPage, key } from "../test/data";

const SECRET = "wh_" + "S3cr3t".repeat(6);

describe("the Agents page", () => {
  test("lists the active keys with name, prefix and when each was used, never a key value", async () => {
    renderApp("/agents", (s) =>
      s.on("GET /api/app/agents", agentsPage([key({ id: "k1", name: "Ada's laptop", lastUsedAt: new Date().toISOString() }), key({ id: "k2", name: "CI bot", prefix: "wh_zzzzzzz" })])),
    );
    await screen.findByRole("heading", { level: 1, name: "Agents & API keys" });
    expect(await screen.findByText("🤖 Ada's laptop")).toBeTruthy();
    expect(screen.getByText("used just now")).toBeTruthy();
    expect(screen.getByText("never used")).toBeTruthy();
    expect(screen.getAllByText("wh_abcdefg…").length).toBe(1);
    expect(document.body.textContent).not.toContain(SECRET);
  });

  test("with no keys it says so", async () => {
    renderApp("/agents", (s) => s.on("GET /api/app/agents", agentsPage([])));
    await screen.findByText("No active keys. Create one above.");
  });

  test("revoked keys stay out of the way until asked for, struck through, with no actions", async () => {
    renderApp("/agents", (s) => s.on("GET /api/app/agents", agentsPage([key(), key({ id: "k2", name: "Old bot", revokedAt: "2026-10-10T00:00:00.000Z" })])));
    const show = await screen.findByRole("button", { name: "Show revoked keys (1)" });
    expect(screen.queryByText("🤖 Old bot")).toBeNull();
    await userEvent.setup().click(show);
    const old = screen.getByText("🤖 Old bot");
    expect(old.className).toContain("line-through");
    expect(within(old.closest("li") as HTMLElement).queryByRole("button")).toBeNull();
  });

  test("creating a key shows the secret once, with a note, and the list reads again without it", async () => {
    const created = key({ id: "k9", name: "CI bot", prefix: SECRET.slice(0, 10) });
    let keys = [key()];
    const { server } = renderApp("/agents", (s) => {
      s.on("GET /api/app/agents", () => agentsPage(keys));
      s.on("POST /api/app/keys", () => {
        keys = [created, ...keys];
        return Response.json({ key: created, secret: SECRET }, { status: 201 });
      });
    });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Key name"), "CI bot");
    await user.click(screen.getByRole("button", { name: "Create key" }));
    await screen.findByText('Key "CI bot" created. Copy it now — it won\'t be shown again.');
    expect(screen.getByText(SECRET)).toBeTruthy();
    expect(server.sent("POST /api/app/keys")[0].body).toEqual({ name: "CI bot" });
    expect(server.sent("POST /api/app/keys")[0].headers["x-csrf-token"]).toBe("csrf-ada");
    await screen.findByText("🤖 CI bot");
    expect(screen.getAllByText(SECRET)).toHaveLength(1); // the list shows the prefix, not the key
  });

  test("a key the server refuses (too many) is explained, with no secret shown", async () => {
    renderApp("/agents", (s) => s.on("POST /api/app/keys", apiError(429, "rate_limited", "Too many attempts. Try again in 60 minutes.")));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Create key" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Too many attempts. Try again in 60 minutes.");
  });

  test("Revoke, Mark all seen and the docs:write switch each call the API for that key and read the page again", async () => {
    const { server } = renderApp("/agents", (s) => {
      s.on("DELETE /api/app/keys/k1", { ok: true });
      s.on("POST /api/app/agents/mark-all-seen", { ok: true });
      s.on("PATCH /api/app/keys/k1", { key: key({ canWriteDocs: true }) });
    });
    const user = userEvent.setup();
    const row = ((await screen.findByText("🤖 Claude — Ada's laptop")).closest("li")) as HTMLElement;
    await user.click(within(row).getByRole("checkbox", { name: /docs:write/ }));
    await waitFor(() => expect(server.sent("PATCH /api/app/keys/k1")).toHaveLength(1));
    expect(server.sent("PATCH /api/app/keys/k1")[0].body).toEqual({ docsWrite: true });
    await user.click(within(row).getByRole("button", { name: "Mark all seen" }));
    await waitFor(() => expect(server.sent("POST /api/app/agents/mark-all-seen")).toHaveLength(1));
    expect(server.sent("POST /api/app/agents/mark-all-seen")[0].body).toEqual({ keyId: "k1" });
    await user.click(within(row).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(server.sent("DELETE /api/app/keys/k1")).toHaveLength(1));
    await waitFor(() => expect(server.sent("GET /api/app/agents").length).toBeGreaterThan(3));
  });

  test("the setup guide carries the commands from the server, and none of them holds a key", async () => {
    renderApp("/agents", (s) => s.on("GET /api/app/agents", agentsPage([key()], { projectKey: "WH", linkRepo: "/wheelhouse:setup WH" })));
    await screen.findByText("2. Pick your setup");
    expect(document.body.textContent).toContain("/wheelhouse:setup WH");
    expect(document.body.textContent).toContain("https://wh.example.test/mcp");
    expect(document.body.textContent).not.toMatch(/wh_[A-Za-z0-9]{12,}/);
    expect(screen.getByRole("heading", { name: "Other agents and CI" })).toBeTruthy();
  });
});
