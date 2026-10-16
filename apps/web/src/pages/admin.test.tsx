import { describe, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ADA, apiError, renderApp } from "../test/harness";
import { adminTeam, adminTeamDetail, invite } from "../test/data";

const admin = (s: { me: unknown }) => (s.me = { ...ADA, isInstanceAdmin: true });

describe("admin: teams", () => {
  test("lists every team with owners, seats, projects and who invited them; yours and suspended ones are marked", async () => {
    renderApp("/admin/teams", (s) => {
      admin(s);
      s.on("GET /api/app/admin/teams", {
        teams: [
          adminTeam({ id: "t1", name: "Analytical Engines", isYours: true, owners: [{ name: "Ada", email: "ada@example.test" }], invitedBy: null }),
          adminTeam({ id: "t2", suspendedAt: "2026-10-10T00:00:00.000Z", lastActivity: new Date().toISOString() }),
        ],
      });
    });
    await screen.findByRole("heading", { level: 1, name: "Teams on this server" });
    const mine = (await screen.findByText("(yours)")).closest("a") as HTMLElement;
    expect(mine.getAttribute("href")).toBe("/admin/teams/t1");
    expect(within(mine).getByText("ada@example.test")).toBeTruthy();
    expect(within(mine).getByText("no activity")).toBeTruthy();
    const theirs = screen.getByText("suspended").closest("a") as HTMLElement;
    expect(within(theirs).getByText(/charles@example.test · invited by ada@example.test/)).toBeTruthy();
    expect(within(theirs).getByText("4 of 5 seats (3 members, 1 pending)")).toBeTruthy();
    expect(within(theirs).getByText("2 projects")).toBeTruthy();
    expect(within(theirs).getByText("just now")).toBeTruthy();
  });
});

describe("admin: one team", () => {
  const open = (detail = adminTeamDetail(), extra: (s: Parameters<Parameters<typeof renderApp>[1] & object>[0]) => void = () => {}) =>
    renderApp("/admin/teams/t2", (s) => {
      admin(s);
      s.on("GET /api/app/admin/teams/t2", { team: detail });
      extra(s);
    });

  test("shows members, invites and keys, and says what an admin never sees", async () => {
    open();
    await screen.findByRole("heading", { level: 1, name: /Babbage & Co/ });
    expect(screen.getByText("Members (1)")).toBeTruthy();
    expect(screen.getByText("charles@example.test", { selector: ".text-xs" })).toBeTruthy();
    expect(screen.getByText("new@example.test")).toBeTruthy();
    expect(screen.getByText("pending")).toBeTruthy();
    expect(screen.getByText("wh_zzzzzzz…")).toBeTruthy();
    expect(screen.getByText("Tickets, comments and the map of this team are not shown here.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "← All teams" }).getAttribute("href")).toBe("/admin/teams");
  });

  test("suspending needs the team's exact name; on success it says how many sign-ins ended and reads the team again", async () => {
    const { server } = open(adminTeamDetail(), (s) => s.on("POST /api/app/admin/teams/t2/suspend", { name: "Babbage & Co", sessionsEnded: 2 }));
    const user = userEvent.setup();
    await user.type(await screen.findByPlaceholderText(/^Type "Babbage & Co" to confirm$/), "Babbage & Co");
    await user.type(screen.getByPlaceholderText("Reason (only you can see it)"), "abuse");
    await user.click(screen.getByRole("button", { name: "Suspend team" }));
    await screen.findByText("Suspended Babbage & Co. 2 sign-ins ended.");
    expect(server.sent("POST /api/app/admin/teams/t2/suspend")[0].body).toEqual({ confirm: "Babbage & Co", reason: "abuse" });
    await waitFor(() => expect(server.sent("GET /api/app/admin/teams/t2").length).toBeGreaterThan(1));
  });

  test("a wrong confirmation is shown in the server's words", async () => {
    open(adminTeamDetail(), (s) => s.on("POST /api/app/admin/teams/t2/suspend", apiError(400, "invalid", "Type the team name exactly to confirm")));
    const user = userEvent.setup();
    await user.type(await screen.findByPlaceholderText(/^Type "Babbage/), "babbage");
    await user.click(screen.getByRole("button", { name: "Suspend team" }));
    expect((await screen.findByText("Type the team name exactly to confirm")).textContent).toBeTruthy();
  });

  test("your own team cannot be suspended, so there is no form", async () => {
    open(adminTeamDetail({ isYours: true }));
    await screen.findByText("This is your own team, so it cannot be suspended.");
    expect(screen.queryByRole("button", { name: "Suspend team" })).toBeNull();
  });

  test("a suspended team shows when, by whom and why, and can be restored", async () => {
    const { server } = open(
      adminTeamDetail({ suspendedAt: "2026-10-10T00:00:00.000Z", suspendedReason: "abuse", suspendedBy: { name: "Ada", email: "ada@example.test" } }),
      (s) => s.on("POST /api/app/admin/teams/t2/restore", { ok: true }),
    );
    await screen.findByText(/Suspended 2026-10-10 by ada@example.test/);
    expect(screen.getByText("Reason: abuse")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Suspend team" })).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Restore team" }));
    await waitFor(() => expect(server.sent("POST /api/app/admin/teams/t2/restore")).toHaveLength(1));
  });

  test("a team that does not exist is a not-found page", async () => {
    renderApp("/admin/teams/t2", (s) => {
      admin(s);
      s.on("GET /api/app/admin/teams/t2", apiError(404, "not_found", "Team not found"));
    });
    await screen.findByTestId("not-found");
  });
});

describe("admin: invite a new team", () => {
  test("creates a link for someone outside the team and lists the pending ones", async () => {
    const { server } = renderApp("/admin/invites", (s) => {
      admin(s);
      s.on("GET /api/app/invites", ({ url }) => ({ invites: url.includes("new_team") ? [invite({ id: "n1", kind: "new_team", email: "founder@example.test", teamName: "Fresh Co" })] : [] }));
      s.on("POST /api/app/invites", { id: "n2", email: "x@example.test", kind: "new_team", expiresAt: "2026-10-23T00:00:00.000Z", link: "https://wh.example.test/invite#NEW" });
    });
    await screen.findByRole("heading", { level: 1, name: "Invite a new team" });
    expect(await screen.findByText(/new team: Fresh Co · expires 2026-10-23/)).toBeTruthy();
    expect(server.sent("GET /api/app/invites")[0].url).toBe("/api/app/invites?kind=new_team");
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("Their email"), "x@example.test");
    await user.type(screen.getByPlaceholderText("Team name (optional)"), "X Inc");
    await user.click(screen.getByRole("button", { name: "Create invite link" }));
    await screen.findByText("https://wh.example.test/invite#NEW");
    expect(server.sent("POST /api/app/invites")[0].body).toEqual({ kind: "new_team", email: "x@example.test", role: "member", tags: "", team: "X Inc" });
  });
});
