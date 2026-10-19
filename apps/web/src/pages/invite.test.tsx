import { afterEach, describe, expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ADA, apiError, renderApp } from "../test/harness";

const TOKEN = "T".repeat(43);
const signedOut = (s: { me: unknown }) => (s.me = null);
const at = (fragment: string) => window.history.replaceState(null, "", `/invite${fragment}`);
afterEach(() => window.history.replaceState(null, "", "/"));

/** The invite page: the token travels in the URL fragment, which browsers never send to a server. */
describe("the invite page", () => {
  test("without the full link it says what is missing", async () => {
    at("");
    renderApp("/invite", signedOut);
    await screen.findByText("This page needs the full invite link you were sent.");
    expect(screen.getByText(/including everything after the # sign/)).toBeTruthy();
  });

  test("the token is taken out of the address bar at once and sent only in a request body, never in a URL", async () => {
    at(`#${TOKEN}`);
    const { server } = renderApp("/invite", (s) => {
      signedOut(s);
      s.on("POST /api/app/invites/peek", { invite: { email: "grace@example.test", kind: "join_team", teamName: "Analytical Engines" } });
    });
    await screen.findByText("Create your account to join Analytical Engines.");
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(TOKEN);
    expect(server.requests.every((r) => !r.includes(TOKEN))).toBe(true);
    expect(server.sent("POST /api/app/invites/peek")[0].body).toEqual({ token: TOKEN });
  });

  test("shows the invited email read-only and asks for a name and the password twice", async () => {
    at(`#${TOKEN}`);
    renderApp("/invite", (s) => {
      signedOut(s);
      s.on("POST /api/app/invites/peek", { invite: { email: "grace@example.test", kind: "join_team", teamName: "Analytical Engines" } });
    });
    const email = (await screen.findByLabelText("Email")) as HTMLInputElement;
    expect(email.value).toBe("grace@example.test");
    expect(email.readOnly).toBe(true);
    expect((screen.getByLabelText("Your name") as HTMLInputElement).required).toBe(true);
    expect((screen.getByLabelText("Password (12+ characters)") as HTMLInputElement).minLength).toBe(12);
    expect(screen.getByLabelText("Repeat password")).toBeTruthy();
  });

  test("a new-team invite says the person gets a team of their own", async () => {
    at(`#${TOKEN}`);
    renderApp("/invite", (s) => {
      signedOut(s);
      s.on("POST /api/app/invites/peek", { invite: { email: "founder@example.test", kind: "new_team", teamName: "Fresh Co" } });
    });
    await screen.findByText("Create your account and your workspace, Fresh Co.");
  });

  test("a bad or used link, and every other bad link, reads the same and points to sign-in", async () => {
    at(`#${TOKEN}`);
    renderApp("/invite", (s) => {
      signedOut(s);
      s.on("POST /api/app/invites/peek", apiError(400, "invalid", "This invite link is invalid or has expired."));
    });
    await screen.findByText("This invite link is invalid or has expired.");
    expect(screen.getByText("Ask the person who invited you for a new link.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to sign in" }).getAttribute("href")).toBe("/login");
    expect(screen.queryByRole("button", { name: "Create account" })).toBeNull();
  });

  test("too many lookups from this address is shown as the server says it; a dropped connection is a gentle retry message", async () => {
    at(`#${TOKEN}`);
    const first = renderApp("/invite", (s) => {
      signedOut(s);
      s.on("POST /api/app/invites/peek", apiError(429, "rate_limited", "Too many attempts. Try again in 15 minutes."));
    });
    await screen.findByText("Too many attempts. Try again in 15 minutes.");
    first.unmount();
    at(`#${TOKEN}`);
    renderApp("/invite", (s) => {
      signedOut(s);
      s.fail["/api/app/invites/peek"] = "network";
    });
    await screen.findByText("Something went wrong. Try the link again.");
  });

  test("accepting creates the account, signs in and lands on the home page", async () => {
    at(`#${TOKEN}`);
    const { server, router, services } = renderApp("/invite", (s) => {
      signedOut(s);
      s.on("POST /api/app/invites/peek", { invite: { email: "grace@example.test", kind: "join_team", teamName: "Analytical Engines" } });
      s.on("POST /api/app/invites/accept", () => ((s.me = ADA), ADA));
    });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Your name"), "Grace Hopper");
    await user.type(screen.getByLabelText("Password (12+ characters)"), "correct horse battery");
    await user.type(screen.getByLabelText("Repeat password"), "correct horse battery");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(server.sent("POST /api/app/invites/accept")[0].body).toEqual({ token: TOKEN, name: "Grace Hopper", password: "correct horse battery", confirm: "correct horse battery" });
    expect(services.queryClient.getQueryData(["me"])).toEqual(ADA);
  });

  test("passwords that do not match, and a link used by someone else a moment ago, are shown and nothing else happens", async () => {
    at(`#${TOKEN}`);
    const { router } = renderApp("/invite", (s) => {
      signedOut(s);
      s.on("POST /api/app/invites/peek", { invite: { email: "grace@example.test", kind: "join_team", teamName: "Analytical Engines" } });
      s.on("POST /api/app/invites/accept", ({ body }) =>
        (body as { confirm: string }).confirm === "different long password"
          ? apiError(400, "invalid", "The two passwords do not match", { fields: { confirm: "The two passwords do not match" } })
          : apiError(400, "invalid", "This invite link is invalid or has expired."),
      );
    });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Your name"), "Grace");
    await user.type(screen.getByLabelText("Password (12+ characters)"), "correct horse battery");
    await user.type(screen.getByLabelText("Repeat password"), "different long password");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The two passwords do not match");
    expect(router.state.location.pathname).toBe("/invite");
  });

  test("it asks search engines not to index it and browsers not to send a referrer, only while it is open", async () => {
    at(`#${TOKEN}`);
    const { unmount } = renderApp("/invite", (s) => {
      signedOut(s);
      s.on("POST /api/app/invites/peek", apiError(400, "invalid", "x"));
    });
    await screen.findByText("x");
    expect(document.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe("noindex, nofollow");
    expect(document.querySelector('meta[name="referrer"]')?.getAttribute("content")).toBe("no-referrer");
    expect(document.title).toBe("Join Wheelhouse");
    unmount();
    expect(document.querySelector('meta[name="robots"]')).toBeNull();
    expect(document.querySelector('meta[name="referrer"]')).toBeNull();
  });

  test("a signed-in person can still open an invite link (it is not an auth page)", async () => {
    at("");
    const { at: path } = renderApp("/invite");
    await screen.findByText("This page needs the full invite link you were sent.");
    expect(path()).toBe("/invite");
  });
});

describe("the invite page, for someone who already has an account", () => {
  const notNew = () => apiError(400, "invalid", "This invite link is invalid or has expired."); // a fresh Response each time: a body can be read once
  const existing = { invite: { email: "ada@example.test", teamName: "Difference Engines", role: "viewer", projects: [{ key: "DE", name: "Engine", role: "editor" }] } };

  test("signed in as the invited address, they are offered to join and keep their account; joining moves them in and forgets the old workspace", async () => {
    at(`#${TOKEN}`);
    const { server, services, router } = renderApp("/invite", (s) => {
      s.on("POST /api/app/invites/peek", notNew());
      s.on("POST /api/app/invites/peek-existing", existing);
      s.on("POST /api/app/invites/accept-existing", { team: { id: "t2", name: "Difference Engines" } });
    });
    services.queryClient.setQueryData(["marker"], "from the old workspace");
    await screen.findByRole("button", { name: "Join Difference Engines" });
    expect(screen.getByText(/You are signed in as/).textContent).toContain("ada@example.test");
    expect(screen.getByText(/You are signed in as/).textContent).toContain("Join Difference Engines as viewer, in Engine (editor)?");
    expect(screen.getByText(/You keep your account and your other workspaces/)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Join Difference Engines" }));
    await waitFor(() => expect(server.sent("POST /api/app/invites/accept-existing")).toHaveLength(1));
    expect(server.sent("POST /api/app/invites/accept-existing")[0].body).toEqual({ token: TOKEN });
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(services.queryClient.getQueryData(["marker"])).toBeUndefined(); // nothing read in the old workspace lingers
    expect(server.requests.every((r) => !r.includes(TOKEN))).toBe(true); // still never in a URL
  });

  test("signed out, a bad link says to sign in with the invited address and open it again", async () => {
    at(`#${TOKEN}`);
    renderApp("/invite", (s) => {
      signedOut(s);
      s.on("POST /api/app/invites/peek", notNew());
      s.on("POST /api/app/invites/peek-existing", apiError(401, "unauthorized", "Not authenticated"));
    });
    await screen.findByText("This invite link is invalid or has expired.");
    expect(screen.getByText(/Already have an account on this server\? Sign in with the email this invite was sent to/)).toBeTruthy();
  });

  test("signed in as someone else, it is just an invalid link (no hint that the address has an account)", async () => {
    at(`#${TOKEN}`);
    renderApp("/invite", (s) => {
      s.on("POST /api/app/invites/peek", notNew());
      s.on("POST /api/app/invites/peek-existing", apiError(400, "invalid", "This invite link is invalid or has expired."));
    });
    await screen.findByText("This invite link is invalid or has expired.");
    expect(screen.queryByText(/Already have an account/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Join/ })).toBeNull();
  });

  test("a refusal on joining (already in it) is shown in the server's words", async () => {
    at(`#${TOKEN}`);
    renderApp("/invite", (s) => {
      s.on("POST /api/app/invites/peek", notNew());
      s.on("POST /api/app/invites/peek-existing", existing);
      s.on("POST /api/app/invites/accept-existing", apiError(409, "conflict", "You are already in this workspace"));
    });
    await userEvent.setup().click(await screen.findByRole("button", { name: "Join Difference Engines" }));
    expect((await screen.findByRole("alert")).textContent).toBe("You are already in this workspace");
  });
});
