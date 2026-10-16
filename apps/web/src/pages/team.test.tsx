import { describe, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiError, renderApp } from "../test/harness";
import { invite, team } from "../test/data";

/** A member's row. The name also appears in the account menu, so look only inside the page. */
const rowOf = (name: string) => within(screen.getByRole("main")).getByText(name).closest("form") as HTMLElement;
const findRow = async (name: string) => (await within(await screen.findByRole("main")).findByText(name)).closest("form") as HTMLElement;

describe("the team page, for an owner", () => {
  test("lists the members with their role and tags, marks you, and offers Save and Remove (never Remove on yourself)", async () => {
    renderApp("/team");
    await screen.findByRole("heading", { level: 1, name: "Analytical Engines" });
    const ada = await findRow("Ada Lovelace");
    expect(within(ada).getByText("(you)")).toBeTruthy();
    expect((within(ada).getByLabelText("Tags for Ada Lovelace") as HTMLInputElement).value).toBe("eng");
    expect(within(ada).getByRole("button", { name: "Save" })).toBeTruthy();
    expect(within(ada).queryByRole("button", { name: "Remove" })).toBeNull();
    const grace = await findRow("Grace Hopper");
    expect((within(grace).getByLabelText("Tags for Grace Hopper") as HTMLInputElement).value).toBe("backend, lead");
    expect(within(grace).getByRole("button", { name: "Remove" })).toBeTruthy();
  });

  test("Save sends the role and the tags as typed, and reads the team again", async () => {
    const { server } = renderApp("/team", (s) => s.on("PATCH /api/app/team/members/u2", { member: team().members[1] }));
    const user = userEvent.setup();
    const tags = (await within(await findRow("Grace Hopper")).findByLabelText("Tags for Grace Hopper")) as HTMLInputElement;
    await user.clear(tags);
    await user.type(tags, "Backend, Ops");
    const before = server.sent("GET /api/app/team").length;
    await user.click(within(rowOf("Grace Hopper")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.sent("PATCH /api/app/team/members/u2")).toHaveLength(1));
    expect(server.sent("PATCH /api/app/team/members/u2")[0].body).toEqual({ role: "member", tags: "Backend, Ops" });
    await waitFor(() => expect(server.sent("GET /api/app/team").length).toBeGreaterThan(before));
  });

  test("Remove sends a DELETE for that member only", async () => {
    const { server } = renderApp("/team", (s) => s.on("DELETE /api/app/team/members/u2", { ok: true }));
    const user = userEvent.setup();
    await user.click(await within(await findRow("Grace Hopper")).findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(server.sent("DELETE /api/app/team/members/u2")).toHaveLength(1));
    expect(server.sent("PATCH /api/app/team/members/u2")).toHaveLength(0);
  });

  test("a refusal (the last owner) is shown on that row, in the server's words", async () => {
    renderApp("/team", (s) => s.on("PATCH /api/app/team/members/u1", apiError(409, "conflict", "A team needs at least one owner")));
    const user = userEvent.setup();
    await user.click(await within(await findRow("Ada Lovelace")).findByRole("button", { name: "Save" }));
    expect((await within(rowOf("Ada Lovelace")).findByRole("alert")).textContent).toBe("A team needs at least one owner");
    expect(within(rowOf("Grace Hopper")).queryByRole("alert")).toBeNull(); // only the row that was refused
  });

  test("the seats are shown, the invite form is there, and pending invites can be revoked", async () => {
    const { server } = renderApp("/team", (s) => {
      s.on("GET /api/app/team", team({ seats: { members: 2, pending: 1, used: 3, max: 5, full: false }, pendingInvites: [invite()] }));
      s.on("DELETE /api/app/invites/i1", { ok: true });
    });
    await screen.findByText("3 of 5 seats used (2 members, 1 pending)");
    expect(screen.getByRole("button", { name: "Create invite link" })).toBeTruthy();
    const pending = (await screen.findByText("grace@example.test", { selector: ".font-medium" })).closest("form") as HTMLElement;
    expect(within(pending).getByText(/member · expires 2026-10-23/)).toBeTruthy();
    await userEvent.setup().click(within(pending).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(server.sent("DELETE /api/app/invites/i1")).toHaveLength(1));
  });

  test("a full team says so and the invite form is switched off", async () => {
    renderApp("/team", (s) => s.on("GET /api/app/team", team({ seats: { members: 5, pending: 0, used: 5, max: 5, full: true } })));
    await screen.findByText("Your team is full. Revoke a pending invite or remove a member to free a seat.");
    expect((screen.getByRole("button", { name: "Create invite link" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByPlaceholderText("Their email") as HTMLInputElement).disabled).toBe(true);
  });

  test("creating an invite shows the link once, in a box to copy from", async () => {
    const { server } = renderApp("/team", (s) =>
      s.on("POST /api/app/invites", { id: "i2", email: "new@example.test", kind: "join_team", expiresAt: "2026-10-23T00:00:00.000Z", link: "https://wh.example.test/invite#SECRET" }),
    );
    const user = userEvent.setup();
    await user.type(await screen.findByPlaceholderText("Their email"), "new@example.test");
    await user.type(screen.getByPlaceholderText("tags: backend, design"), "design");
    await user.click(screen.getByRole("button", { name: "Create invite link" }));
    await screen.findByText("Invite created for new@example.test. Send them this link. It is shown only once, works for one person and expires on 2026-10-23:");
    expect(screen.getByText("https://wh.example.test/invite#SECRET")).toBeTruthy();
    expect(server.sent("POST /api/app/invites")[0].body).toEqual({ kind: "join_team", email: "new@example.test", role: "member", tags: "design", team: "" });
  });

  test("an invite problem (already invited, not allowed) is shown in the server's words", async () => {
    renderApp("/team", (s) => s.on("POST /api/app/invites", apiError(409, "conflict", "That email already has a pending invite. Revoke it first to send a new one.")));
    const user = userEvent.setup();
    await user.type(await screen.findByPlaceholderText("Their email"), "dup@example.test");
    await user.click(screen.getByRole("button", { name: "Create invite link" }));
    expect((await screen.findByText(/already has a pending invite/)).textContent).toContain("Revoke it first");
  });
});

describe("the team page, for a member", () => {
  const asMember = (s: { on: (r: string, a: unknown) => unknown }) => s.on("GET /api/app/team", team({ role: "member", pendingInvites: [] }));

  test("shows the roster read-only, with chips instead of fields, and no invite section", async () => {
    renderApp("/team", asMember);
    await screen.findByRole("heading", { level: 1, name: "Analytical Engines" });
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.queryByText("Invite someone")).toBeNull();
    const grace = await findRow("Grace Hopper");
    for (const chip of ["member", "backend", "lead"]) expect(within(grace).getByText(chip)).toBeTruthy();
  });

  test("but can still change their own password", async () => {
    renderApp("/team", asMember);
    expect(await screen.findByRole("heading", { name: "Your password" })).toBeTruthy();
  });
});

describe("changing your password", () => {
  const fill = async (current: string, next: string) => {
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Current password"), current);
    await user.type(screen.getByLabelText("New password"), next);
    await user.click(screen.getByRole("button", { name: "Update" }));
  };

  test("sends both passwords and confirms", async () => {
    const { server } = renderApp("/team", (s) => s.on("POST /api/app/me/password", { ok: true }));
    await fill("old password 1", "a brand new passphrase");
    expect((await screen.findByRole("status")).textContent).toBe("Password updated");
    expect(server.sent("POST /api/app/me/password")[0].body).toEqual({ current: "old password 1", next: "a brand new passphrase" });
  });

  test("a wrong current password is shown as the server says it", async () => {
    renderApp("/team", (s) => s.on("POST /api/app/me/password", apiError(400, "invalid", "Current password is wrong", { fields: { current: "Current password is wrong" } })));
    await fill("not mine", "a brand new passphrase");
    expect((await screen.findByRole("alert")).textContent).toBe("Current password is wrong");
  });

  test("the new password must be at least twelve characters, even before it is sent", async () => {
    renderApp("/team");
    expect(((await screen.findByLabelText("New password")) as HTMLInputElement).minLength).toBe(12);
    expect((screen.getByLabelText("Current password") as HTMLInputElement).autocomplete).toBe("current-password");
  });
});

describe("loading and failing", () => {
  test("a busy skeleton while the team loads", async () => {
    let release!: () => void;
    renderApp("/team", (s) => (s.hold = new Promise<void>((r) => (release = r))));
    // (the first screen's own data is held too, so the shell's skeleton shows first)
    expect(await screen.findByRole("status")).toBeTruthy();
    release();
    await screen.findByRole("heading", { level: 1, name: "Analytical Engines" });
  });

  test("a message with Try again if the team cannot be read, and Try again reads it again", async () => {
    let healthy = false;
    const { server } = renderApp("/team", (s) =>
      s.on("GET /api/app/team", () => (healthy ? team() : apiError(404 + 96, "internal", "Internal error"))),
    );
    const alert = await screen.findByRole("alert", {}, { timeout: 8000 });
    expect(alert.textContent).toContain("Internal error");
    healthy = true;
    await userEvent.setup().click(within(alert).getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { level: 1, name: "Analytical Engines" });
    expect(server.sent("GET /api/app/team").length).toBeGreaterThan(1);
  });
});
