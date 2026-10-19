import { describe, expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ADA, apiError, renderApp } from "../test/harness";

const signedOut = (s: { me: unknown }) => (s.me = null);

/** Sign-in and sign-up as the Next app had them: same fields, same messages, and a signed-in person is sent home. */
describe("sign in", () => {
  test("asks for an email and a password, and offers sign-up when the server allows it", async () => {
    renderApp("/login", (s) => {
      signedOut(s);
      s.on("GET /api/app/auth/options", { signupOpen: true });
    });
    await screen.findByRole("button", { name: "Sign in" });
    expect((screen.getByLabelText("Email") as HTMLInputElement).type).toBe("email");
    expect((screen.getByLabelText("Password") as HTMLInputElement).autocomplete).toBe("current-password");
    expect((await screen.findByRole("link", { name: "Sign up" })).getAttribute("href")).toBe("/signup");
  });

  test("shows a Google button that is disabled, after the sign-in button, with no card around the page", async () => {
    renderApp("/login", (s) => {
      signedOut(s);
      s.on("GET /api/app/auth/options", { signupOpen: true });
    });
    const google = (await screen.findByRole("button", { name: "Sign in with Google" })) as HTMLButtonElement;
    expect(google.disabled).toBe(true);
    expect(document.querySelectorAll(".card")).toHaveLength(0);
    const page = google.closest("main")!;
    expect(page.contains(screen.getByLabelText("Email"))).toBe(true);
    expect(page.contains(screen.getByText("The board your team and your AI agents share."))).toBe(true);
    expect(page.contains(screen.getByRole("heading", { name: "Log in to your account" }))).toBe(true);
    // Google comes after the sign-in button, at the bottom.
    const signIn = screen.getByRole("button", { name: "Sign in" });
    expect(signIn.compareDocumentPosition(google) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("the eye button shows and hides the password", async () => {
    renderApp("/login", (s) => {
      signedOut(s);
      s.on("GET /api/app/auth/options", { signupOpen: true });
    });
    const user = userEvent.setup();
    const password = (await screen.findByLabelText("Password")) as HTMLInputElement;
    expect(password.type).toBe("password");
    await user.click(screen.getByRole("button", { name: "Show password" }));
    expect(password.type).toBe("text");
    await user.click(screen.getByRole("button", { name: "Hide password" }));
    expect(password.type).toBe("password");
  });

  test("on an invite-only server it says so instead of offering sign-up", async () => {
    renderApp("/login", (s) => {
      signedOut(s);
      s.on("GET /api/app/auth/options", { signupOpen: false });
    });
    await screen.findByText("Invite only. Ask for an invite link.");
    expect(screen.queryByRole("link", { name: "Sign up" })).toBeNull();
  });

  test("a right password signs in, remembers who, and lands on the home page", async () => {
    const { at, server, services } = renderApp("/login", (s) => {
      signedOut(s);
      s.on("POST /api/app/auth/login", () => {
        s.me = ADA;
        return ADA;
      });
    });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Email"), "ada@example.test");
    await user.type(screen.getByLabelText("Password"), "correct horse battery");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(at()).toBe("/"));
    await screen.findByRole("heading", { level: 1, name: /^Good / });
    expect(server.sent("POST /api/app/auth/login")[0].body).toEqual({ email: "ada@example.test", password: "correct horse battery" });
    expect(services.queryClient.getQueryData(["me"])).toEqual(ADA);
  });

  test("signing in is sent with the anonymous CSRF token (there is no session yet)", async () => {
    const { server } = renderApp("/login", (s) => {
      signedOut(s);
      s.on("POST /api/app/auth/login", () => ((s.me = ADA), ADA));
    });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Email"), "a@b.co");
    await user.type(screen.getByLabelText("Password"), "x");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("heading", { level: 1, name: /^Good / });
    expect(server.sent("POST /api/app/auth/login")[0].headers["x-csrf-token"]).toBe("anonymous");
  });

  test("a wrong password shows the server's message and stays on the page", async () => {
    const { at } = renderApp("/login", (s) => {
      signedOut(s);
      s.on("POST /api/app/auth/login", apiError(401, "unauthorized", "Invalid email or password"));
    });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Email"), "ada@example.test");
    await user.type(screen.getByLabelText("Password"), "nope");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Invalid email or password");
    expect(at()).toBe("/login");
  });

  test("too many tries and a suspended team are told in the server's own words", async () => {
    for (const [reply, text] of [
      [apiError(429, "rate_limited", "Too many attempts. Try again in 15 minutes.", undefined, { "retry-after": "900" }), "Too many attempts. Try again in 15 minutes."],
      [apiError(403, "team_suspended", "This team has been suspended. Contact the administrator."), "This team has been suspended. Contact the administrator."],
    ] as const) {
      const { unmount } = renderApp("/login", (s) => {
        signedOut(s);
        s.on("POST /api/app/auth/login", reply);
      });
      const user = userEvent.setup();
      await user.type(await screen.findByLabelText("Email"), "a@b.co");
      await user.type(screen.getByLabelText("Password"), "x");
      await user.click(screen.getByRole("button", { name: "Sign in" }));
      expect((await screen.findByRole("alert")).textContent).toBe(text);
      unmount();
    }
  });

  test("when the server cannot be reached the form says so and keeps what was typed", async () => {
    renderApp("/login", (s) => {
      signedOut(s);
      s.fail["/api/app/auth/login"] = "network";
    });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Email"), "ada@example.test");
    await user.type(screen.getByLabelText("Password"), "x");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Cannot reach Wheelhouse. Check your connection and try again.");
  });
});

describe("sign up", () => {
  test("asks for a name, an optional workspace name, an email and a password of at least 12 characters", async () => {
    renderApp("/signup", (s) => {
      signedOut(s);
      s.on("GET /api/app/auth/options", { signupOpen: true });
    });
    await screen.findByRole("button", { name: "Create account" });
    expect((screen.getByLabelText("Name") as HTMLInputElement).required).toBe(true);
    expect((screen.getByLabelText("Workspace name") as HTMLInputElement).required).toBe(false);
    const pw = screen.getByLabelText("Password") as HTMLInputElement;
    expect(pw.minLength).toBe(12);
    expect(pw.autocomplete).toBe("new-password");
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/login");
  });

  test("creates the account, signs in and lands on the home page", async () => {
    const { at, server } = renderApp("/signup", (s) => {
      signedOut(s);
      s.on("GET /api/app/auth/options", { signupOpen: true });
      s.on("POST /api/app/auth/signup", () => ((s.me = ADA), ADA));
    });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Name"), "Ada Lovelace");
    await user.type(screen.getByLabelText("Workspace name"), "Analytical Engines");
    await user.type(screen.getByLabelText("Email"), "ada@example.test");
    await user.type(screen.getByLabelText("Password"), "correct horse battery");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(at()).toBe("/"));
    expect(server.sent("POST /api/app/auth/signup")[0].body).toEqual({ name: "Ada Lovelace", email: "ada@example.test", password: "correct horse battery", team: "Analytical Engines" });
  });

  test("a taken email is shown as the server says it", async () => {
    renderApp("/signup", (s) => {
      signedOut(s);
      s.on("GET /api/app/auth/options", { signupOpen: true });
      s.on("POST /api/app/auth/signup", apiError(409, "conflict", "An account with that email already exists", { fields: { email: "taken" } }));
    });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Name"), "Ada");
    await user.type(screen.getByLabelText("Email"), "ada@example.test");
    await user.type(screen.getByLabelText("Password"), "correct horse battery");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect((await screen.findByRole("alert")).textContent).toBe("An account with that email already exists");
  });

  test("when signups are closed the page says so, with a way back, and no form", async () => {
    renderApp("/signup", (s) => {
      signedOut(s);
      s.on("GET /api/app/auth/options", { signupOpen: false });
    });
    await screen.findByText("Signups are closed on this server.");
    expect(screen.getByText("Invite only. Ask for an invite link, then sign in.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to sign in" }).getAttribute("href")).toBe("/login");
    expect(screen.queryByRole("button", { name: "Create account" })).toBeNull();
  });
});
