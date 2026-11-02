import { describe, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiError, renderApp } from "../test/harness";
import { invite, workspace } from "../test/data";

/** A member's row. The name also appears in the account menu, so look only inside the page. */
const rowOf = (name: string) => within(screen.getByRole("main")).getByText(name).closest("form") as HTMLElement;
const findRow = async (name: string) => (await within(await screen.findByRole("main")).findByText(name)).closest("form") as HTMLElement;

describe("the workspace page, for an owner", () => {
  test("lists the members with their role and tags, marks you, and offers Save and Remove (never Remove on yourself)", async () => {
    renderApp("/workspace");
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

  test("Save sends the role and the tags as typed, and reads the workspace again", async () => {
    const { server } = renderApp("/workspace", (s) => s.on("PATCH /api/app/workspace/members/u2", { member: workspace().members[1] }));
    const user = userEvent.setup();
    const tags = (await within(await findRow("Grace Hopper")).findByLabelText("Tags for Grace Hopper")) as HTMLInputElement;
    await user.clear(tags);
    await user.type(tags, "Backend, Ops");
    const before = server.sent("GET /api/app/workspace").length;
    await user.click(within(rowOf("Grace Hopper")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.sent("PATCH /api/app/workspace/members/u2")).toHaveLength(1));
    expect(server.sent("PATCH /api/app/workspace/members/u2")[0].body).toEqual({ role: "member", tags: "Backend, Ops" });
    await waitFor(() => expect(server.sent("GET /api/app/workspace").length).toBeGreaterThan(before));
  });

  test("Remove sends a DELETE for that member only", async () => {
    const { server } = renderApp("/workspace", (s) => s.on("DELETE /api/app/workspace/members/u2", { ok: true }));
    const user = userEvent.setup();
    await user.click(await within(await findRow("Grace Hopper")).findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(server.sent("DELETE /api/app/workspace/members/u2")).toHaveLength(1));
    expect(server.sent("PATCH /api/app/workspace/members/u2")).toHaveLength(0);
  });

  test("a refusal (the last owner) is shown on that row, in the server's words", async () => {
    renderApp("/workspace", (s) => s.on("PATCH /api/app/workspace/members/u1", apiError(409, "conflict", "A workspace needs at least one owner")));
    const user = userEvent.setup();
    await user.click(await within(await findRow("Ada Lovelace")).findByRole("button", { name: "Save" }));
    expect((await within(rowOf("Ada Lovelace")).findByRole("alert")).textContent).toBe("A workspace needs at least one owner");
    expect(within(rowOf("Grace Hopper")).queryByRole("alert")).toBeNull(); // only the row that was refused
  });

  test("the seats are shown, the invite form is there, and pending invites can be revoked", async () => {
    const { server } = renderApp("/workspace", (s) => {
      s.on("GET /api/app/workspace", workspace({ seats: { members: 2, pending: 1, used: 3, max: 5, full: false }, pendingInvites: [invite()] }));
      s.on("DELETE /api/app/invites/i1", { ok: true });
    });
    await screen.findByText("3 of 5 seats used (2 members, 1 pending)");
    expect(screen.getByRole("button", { name: "Create invite link" })).toBeTruthy();
    const pending = (await screen.findByText("grace@example.test", { selector: ".font-medium" })).closest("form") as HTMLElement;
    expect(within(pending).getByText(/member · expires 2026-10-23/)).toBeTruthy();
    await userEvent.setup().click(within(pending).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(server.sent("DELETE /api/app/invites/i1")).toHaveLength(1));
  });

  test("a full workspace says so and the invite form is switched off", async () => {
    renderApp("/workspace", (s) => s.on("GET /api/app/workspace", workspace({ seats: { members: 5, pending: 0, used: 5, max: 5, full: true } })));
    await screen.findByText("Your workspace is full. Revoke a pending invite or remove a member to free a seat.");
    expect((screen.getByRole("button", { name: "Create invite link" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByPlaceholderText("Their email") as HTMLInputElement).disabled).toBe(true);
  });

  test("creating an invite shows the link once, in a box to copy from", async () => {
    const { server } = renderApp("/workspace", (s) =>
      s.on("POST /api/app/invites", { id: "i2", email: "new@example.test", kind: "join_workspace", expiresAt: "2026-10-23T00:00:00.000Z", link: "https://wh.example.test/invite#SECRET" }),
    );
    const user = userEvent.setup();
    await user.type(await screen.findByPlaceholderText("Their email"), "new@example.test");
    await user.type(screen.getByPlaceholderText("tags: backend, design"), "design");
    await user.click(screen.getByRole("button", { name: "Create invite link" }));
    await screen.findByText("Invite created for new@example.test. Send them this link. It is shown only once, works for one person and expires on 2026-10-23:");
    expect(screen.getByText("https://wh.example.test/invite#SECRET")).toBeTruthy();
    expect(server.sent("POST /api/app/invites")[0].body).toEqual({ kind: "join_workspace", email: "new@example.test", role: "member", tags: "design", workspace: "" });
  });

  test("the invite form offers only the teams you administer, and sends the ones ticked with a team role", async () => {
    const { server } = renderApp("/workspace", (s) => {
      s.teams = [
        { id: "p1", key: "AA", name: "Alpha", description: "", createdAt: "2026-10-01T00:00:00.000Z", icon: null, iconColor: null, role: "admin" },
        { id: "p2", key: "BB", name: "Beta", description: "", createdAt: "2026-10-01T00:00:00.000Z", icon: null, iconColor: null, role: "editor" },
      ];
      s.on("POST /api/app/invites", { id: "i2", email: "new@example.test", kind: "join_workspace", expiresAt: "2026-10-23T00:00:00.000Z", link: "https://wh.example.test/invite#SECRET" });
    });
    const user = userEvent.setup();
    await user.type(await screen.findByPlaceholderText("Their email"), "new@example.test");
    expect(await screen.findByRole("checkbox", { name: /Alpha/ })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /Beta/ })).toBeNull(); // an editor of Beta cannot hand it out
    await user.click(screen.getByRole("checkbox", { name: /Alpha/ }));
    await user.click(screen.getByRole("button", { name: "Create invite link" }));
    await waitFor(() => expect(server.sent("POST /api/app/invites")).toHaveLength(1));
    expect((server.sent("POST /api/app/invites")[0].body as { teams: unknown }).teams).toEqual([{ team: "AA", role: "editor" }]);
  });

  test("a pending invite says which teams it adds the person to", async () => {
    renderApp("/workspace", (s) => s.on("GET /api/app/workspace", workspace({ pendingInvites: [invite({ teams: [{ key: "AA", name: "Alpha", role: "viewer" }] })] })));
    expect(await screen.findByText(/joins AA as viewer/)).toBeTruthy();
  });

  test("an invite problem (already invited, not allowed) is shown in the server's words", async () => {
    renderApp("/workspace", (s) => s.on("POST /api/app/invites", apiError(409, "conflict", "That email already has a pending invite. Revoke it first to send a new one.")));
    const user = userEvent.setup();
    await user.type(await screen.findByPlaceholderText("Their email"), "dup@example.test");
    await user.click(screen.getByRole("button", { name: "Create invite link" }));
    expect((await screen.findByText(/already has a pending invite/)).textContent).toContain("Revoke it first");
  });
});

describe("the workspace page, for a member", () => {
  const asMember = (s: { on: (r: string, a: unknown) => unknown }) => s.on("GET /api/app/workspace", workspace({ role: "member", pendingInvites: [] }));

  test("shows the roster read-only, with chips instead of fields, and no invite section", async () => {
    renderApp("/workspace", asMember);
    await screen.findByRole("heading", { level: 1, name: "Analytical Engines" });
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.queryByText("Invite someone")).toBeNull();
    const grace = await findRow("Grace Hopper");
    for (const chip of ["member", "backend", "lead"]) expect(within(grace).getByText(chip)).toBeTruthy();
  });

  test("the password form is not on this page: it lives under Settings", async () => {
    renderApp("/workspace", asMember);
    await screen.findByRole("heading", { level: 1, name: "Analytical Engines" });
    expect(screen.queryByRole("heading", { name: "Your password" })).toBeNull();
  });
});

describe("loading and failing", () => {
  test("a busy skeleton while the workspace loads", async () => {
    let release!: () => void;
    renderApp("/workspace", (s) => (s.hold = new Promise<void>((r) => (release = r))));
    // (the first screen's own data is held too, so the shell's skeleton shows first)
    expect(await screen.findByRole("status")).toBeTruthy();
    release();
    await screen.findByRole("heading", { level: 1, name: "Analytical Engines" });
  });

  test("a message with Try again if the workspace cannot be read, and Try again reads it again", async () => {
    let healthy = false;
    const { server } = renderApp("/workspace", (s) =>
      s.on("GET /api/app/workspace", () => (healthy ? workspace() : apiError(404 + 96, "internal", "Internal error"))),
    );
    const alert = await screen.findByRole("alert", {}, { timeout: 8000 });
    expect(alert.textContent).toContain("Internal error");
    healthy = true;
    await userEvent.setup().click(within(alert).getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { level: 1, name: "Analytical Engines" });
    expect(server.sent("GET /api/app/workspace").length).toBeGreaterThan(1);
  });
});

describe("the workspace page and team access (ADR-23)", () => {
  test("an admin edits members and invites, but cannot touch an owner or hand out the owner role", async () => {
    renderApp("/workspace", (s) => s.on("GET /api/app/workspace", workspace({ role: "admin" })));
    await screen.findByRole("heading", { level: 1, name: "Analytical Engines" });
    const ada = await findRow("Ada Lovelace"); // an owner: read only for an admin
    expect(within(ada).queryByRole("button", { name: "Save" })).toBeNull();
    expect(within(ada).getByText("owner")).toBeTruthy();
    const grace = await findRow("Grace Hopper");
    expect(within(grace).getByRole("button", { name: "Save" })).toBeTruthy();
    const user = userEvent.setup();
    await user.click(within(grace).getByRole("combobox"));
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options).toEqual(["admin", "member", "viewer", "guest"]); // no owner
    await user.keyboard("{Escape}");
    expect(await screen.findByRole("button", { name: "Create invite link" })).toBeTruthy();
  });

  test("an owner is offered all five roles", async () => {
    renderApp("/workspace");
    const user = userEvent.setup();
    await user.click(within(await findRow("Grace Hopper")).getByRole("combobox"));
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["owner", "admin", "member", "viewer", "guest"]);
  });

  test("Save sends the chosen role, whatever it is", async () => {
    const { server } = renderApp("/workspace", (s) => s.on("PATCH /api/app/workspace/members/u2", { member: workspace().members[1] }));
    const user = userEvent.setup();
    await user.click(within(await findRow("Grace Hopper")).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "viewer" }));
    await user.click(within(rowOf("Grace Hopper")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.sent("PATCH /api/app/workspace/members/u2")).toHaveLength(1));
    expect(server.sent("PATCH /api/app/workspace/members/u2")[0].body).toMatchObject({ role: "viewer" });
  });

  test("a plain member sees the list read only, with no invite form, team list or access log, and asks for neither", async () => {
    const { server } = renderApp("/workspace", (s) => s.on("GET /api/app/workspace", workspace({ role: "member", pendingInvites: [] })));
    await screen.findByRole("heading", { level: 1, name: "Analytical Engines" });
    expect(screen.queryByRole("button", { name: "Create invite link" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Teams" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Access log" })).toBeNull();
    expect(server.sent("GET /api/app/access/teams")).toHaveLength(0);
    expect(server.sent("GET /api/app/access/audit")).toHaveLength(0);
  });

  test("owners see every team by name and admins, and can join one as admin", async () => {
    const { server } = renderApp("/workspace", (s) => {
      s.on("GET /api/app/access/teams", {
        teams: [
          { id: "p1", key: "AA", name: "Analytical Engine", admins: ["Ada Lovelace"], memberCount: 3, isMember: true },
          { id: "p2", key: "BB", name: "Difference Engine", admins: ["Charles Babbage"], memberCount: 1, isMember: false },
        ],
      });
      s.on("POST /api/app/teams/BB/join", { team: { id: "p2", key: "BB", name: "Difference Engine" } });
    });
    const teams = (await screen.findByRole("heading", { name: "Teams" })).closest("section") as HTMLElement;
    expect(await within(teams).findByText("Difference Engine")).toBeTruthy();
    expect(within(teams).getByText(/1 member · admin: Charles Babbage/)).toBeTruthy();
    expect(within(teams).getByText("you are in")).toBeTruthy(); // for the team they are already in
    expect(within(teams).queryByRole("button", { name: "Join Analytical Engine as admin" })).toBeNull();
    await userEvent.setup().click(within(teams).getByRole("button", { name: "Join Difference Engine as admin" }));
    await waitFor(() => expect(server.sent("POST /api/app/teams/BB/join")).toHaveLength(1));
  });

  test("the access log lists who changed access, newest first", async () => {
    renderApp("/workspace", (s) =>
      s.on("GET /api/app/access/audit", {
        events: [
          { seq: 2, actorName: "Ada Lovelace", action: "team.admin_joined", targetType: "user", targetId: "u1", teamKey: "BB", before: null, after: { role: "admin" }, createdAt: "2026-10-18T10:00:00.000Z" },
          { seq: 1, actorName: "Grace Hopper", action: "team.member_role_changed", targetType: "user", targetId: "u3", teamKey: "AA", before: { role: "viewer" }, after: { role: "editor" }, createdAt: "2026-10-17T10:00:00.000Z" },
        ],
      }),
    );
    const log = (await screen.findByRole("heading", { name: "Access log" })).closest("section") as HTMLElement;
    const items = await within(log).findAllByRole("listitem");
    expect(items[0].textContent).toContain("Ada Lovelace joined a team as admin");
    expect(items[0].textContent).toContain("BB");
    expect(items[1].textContent).toContain("viewer → editor");
  });
});
