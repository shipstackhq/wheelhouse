import { describe, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiError, renderApp } from "../../test/harness";
import { githubStatus, repo } from "../../test/data";

const open = (path = "/p/AA/repos", setup: Parameters<typeof renderApp>[1] = () => {}) => renderApp(path, setup);
const card = async (name: string) => (await screen.findByText(name, { selector: ".font-semibold" })).closest(".card") as HTMLElement;
/** The card, once it has its answer (it shows "Loading…" until then). */
const githubCard = async () => {
  const c = (await screen.findByRole("heading", { level: 2, name: "GitHub" })).closest("section") as HTMLElement;
  await waitFor(() => expect(c.textContent).not.toContain("Loading…"));
  return (await screen.findByRole("heading", { level: 2, name: "GitHub" })).closest("section") as HTMLElement;
};

describe("the repositories", () => {
  test("each repository shows its role, state, provider, branch, path limit and when it last heard from GitHub", async () => {
    open("/p/AA/repos", (s) =>
      s.on("GET /api/app/projects/AA/repositories", {
        repositories: [
          repo(),
          repo({ id: "r2", displayName: "Web", role: "frontend", slug: "web", provider: "github", lifecycle: "being_replaced", pathLimit: "packages/web/", lastEventAt: "2026-10-16T12:00:00.000Z" }),
        ],
      }),
    );
    const backend = await card("Backend");
    expect(within(backend).getByText("backend", { selector: ".chip" })).toBeTruthy();
    expect(within(backend).getByText("live")).toBeTruthy();
    expect(within(backend).getByText("local")).toBeTruthy();
    expect(backend.textContent).toContain("backend · branch main · no activity yet");
    const web = await card("Web");
    expect(within(web).getByText("being replaced")).toBeTruthy();
    expect(web.textContent).toContain("limited to packages/web/");
    expect(web.textContent).toContain("last activity");
  });

  test("with none it says so; a retired one can no longer be edited", async () => {
    const { unmount } = open("/p/AA/repos", (s) => s.on("GET /api/app/projects/AA/repositories", { repositories: [] }));
    await screen.findByText("No repositories yet.");
    unmount();
    open("/p/AA/repos", (s) => s.on("GET /api/app/projects/AA/repositories", { repositories: [repo({ lifecycle: "retired" })] }));
    const retired = await card("Backend");
    expect(within(retired).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(retired).queryByRole("button", { name: "Retire" })).toBeNull();
  });

  test("+ Add repository needs a name and a role, and saves what was typed; the list is read again", async () => {
    const { server } = open("/p/AA/repos", (s) => s.on("POST /api/app/projects/AA/repositories", { repository: repo({ id: "r9" }) }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "+ Add repository" }));
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.type(screen.getByPlaceholderText(/^Display name/), "Mobile");
    expect(save.disabled).toBe(true);
    await user.type(screen.getByPlaceholderText(/^Role/), "ios");
    expect(save.disabled).toBe(false);
    await user.type(screen.getByPlaceholderText(/^Path limit/), "apps/ios/");
    await user.click(save);
    await waitFor(() => expect(server.sent("POST /api/app/projects/AA/repositories")).toHaveLength(1));
    expect(server.sent("POST /api/app/projects/AA/repositories")[0].body).toEqual({ displayName: "Mobile", role: "ios", provider: "local", defaultBranch: "main", pathLimit: "apps/ios/", lifecycle: "live" });
    expect(server.sent("POST /api/app/projects/AA/repositories")[0].headers["x-csrf-token"]).toBe("csrf-ada");
    await waitFor(() => expect(screen.queryByPlaceholderText(/^Display name/)).toBeNull());
    await waitFor(() => expect(server.sent("GET /api/app/projects/AA/repositories").length).toBeGreaterThan(1));
  });

  test("a refusal shows the server's words and keeps the form open; Cancel closes it", async () => {
    open("/p/AA/repos", (s) => s.on("POST /api/app/projects/AA/repositories", apiError(400, "invalid", "Repository \"backend\" already exists")));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "+ Add repository" }));
    await user.type(screen.getByPlaceholderText(/^Display name/), "Backend");
    await user.type(screen.getByPlaceholderText(/^Role/), "backend");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText('Repository "backend" already exists')).toBeTruthy();
    expect(screen.getByPlaceholderText(/^Display name/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByPlaceholderText(/^Display name/)).toBeNull();
  });

  test("Edit starts from what is there, and clearing the path limit sends null", async () => {
    const { server } = open("/p/AA/repos", (s) => {
      s.on("GET /api/app/projects/AA/repositories", { repositories: [repo({ pathLimit: "packages/api/" })] });
      s.on("PATCH /api/app/projects/AA/repositories/r1", { repository: repo() });
    });
    const user = userEvent.setup();
    await user.click(within(await card("Backend")).getByRole("button", { name: "Edit" }));
    expect((screen.getByPlaceholderText(/^Display name/) as HTMLInputElement).value).toBe("Backend");
    expect((screen.getByPlaceholderText(/^Path limit/) as HTMLInputElement).value).toBe("packages/api/");
    await user.clear(screen.getByPlaceholderText(/^Path limit/));
    await user.clear(screen.getByPlaceholderText(/^Role/));
    await user.type(screen.getByPlaceholderText(/^Role/), "api");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.sent("PATCH /api/app/projects/AA/repositories/r1")).toHaveLength(1));
    expect(server.sent("PATCH /api/app/projects/AA/repositories/r1")[0].body).toEqual({ displayName: "Backend", role: "api", provider: "local", defaultBranch: "main", pathLimit: null, lifecycle: "live" });
  });

  test("Retire asks first", async () => {
    const { server } = open("/p/AA/repos", (s) => s.on("POST /api/app/projects/AA/repositories/r1/retire", { repository: repo({ lifecycle: "retired" }) }));
    const user = userEvent.setup();
    await user.click(within(await card("Backend")).getByRole("button", { name: "Retire" }));
    const ask = await screen.findByRole("alertdialog");
    expect(within(ask).getByText('Retire "Backend"?')).toBeTruthy();
    await user.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(server.sent("POST /api/app/projects/AA/repositories/r1/retire")).toHaveLength(0);
    await user.click(within(await card("Backend")).getByRole("button", { name: "Retire" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Retire" }));
    await waitFor(() => expect(server.sent("POST /api/app/projects/AA/repositories/r1/retire")).toHaveLength(1));
  });
});

describe("Connect GitHub", () => {
  test("not set up on this server: an owner is told which settings to set, a member is not", async () => {
    const { unmount } = open("/p/AA/repos", (s) => s.on("GET /api/app/projects/AA/repositories/github", githubStatus({ configured: false, missing: ["GITHUB_APP_ID", "GITHUB_APP_SLUG"], installations: [] })));
    const owner = await githubCard();
    expect(owner.textContent).toContain("GitHub is not set up on this server");
    expect(within(owner).getByText("GITHUB_APP_ID")).toBeTruthy();
    expect(within(owner).getByText("GITHUB_APP_SLUG")).toBeTruthy();
    expect(within(owner).queryByRole("link")).toBeNull();
    unmount();
    open("/p/AA/repos", (s) => s.on("GET /api/app/projects/AA/repositories/github", githubStatus({ configured: false, missing: [], isOwner: false, installations: [] })));
    const member = await githubCard();
    expect(member.textContent).toContain("GitHub is not set up on this server");
    expect(member.textContent).not.toContain("GITHUB_");
  });

  test("a member is told an owner connects it, and sees no way to", async () => {
    open("/p/AA/repos", (s) => s.on("GET /api/app/projects/AA/repositories/github", githubStatus({ isOwner: false, installations: [] })));
    const c = await githubCard();
    expect(c.textContent).toContain("A workspace owner connects GitHub for this project.");
    expect(within(c).queryByRole("link")).toBeNull();
    expect(within(c).queryByRole("button", { name: "Connect" })).toBeNull();
  });

  test("an owner goes to GitHub with a plain link (a full page load), and sees the repositories to choose from", async () => {
    open();
    const c = await githubCard();
    const link = within(c).getByRole("link", { name: "Add or change repositories on GitHub" });
    expect(link.getAttribute("href")).toBe("/api/github/install?project=AA");
    expect(within(c).getByText("acme")).toBeTruthy();
    expect(within(c).getByText("acme/web")).toBeTruthy();
    expect(within(c).getByText("private")).toBeTruthy();
    expect(within(c).getAllByRole("button", { name: "Connect" })).toHaveLength(2);
  });

  test("before any installation the button says Connect GitHub; the project key is escaped in the link", async () => {
    open("/p/AA/repos", (s) => s.on("GET /api/app/projects/AA/repositories/github", githubStatus({ installations: [] })));
    const c = await githubCard();
    expect(within(c).getByRole("link", { name: "Connect GitHub" }).getAttribute("href")).toBe("/api/github/install?project=AA");
  });

  test("Connect sends the installation, the repository's GitHub id, and the role and path limit typed; empty ones are left out", async () => {
    const { server } = open("/p/AA/repos", (s) => s.on("POST /api/app/projects/AA/repositories/github", { repository: repo({ id: "r7" }) }));
    const user = userEvent.setup();
    const c = await githubCard();
    await user.type(within(c).getByLabelText("Role of acme/web"), " frontend ");
    await user.type(within(c).getByLabelText("Path limit for acme/web"), "apps/web/");
    await user.click(within(c).getAllByRole("button", { name: "Connect" })[0]);
    await waitFor(() => expect(server.sent("POST /api/app/projects/AA/repositories/github")).toHaveLength(1));
    expect(server.sent("POST /api/app/projects/AA/repositories/github")[0].body).toEqual({ installationId: "1001", repoId: "5001", role: "frontend", pathLimit: "apps/web/" });
    await user.click(within(await githubCard()).getAllByRole("button", { name: "Connect" })[1]);
    await waitFor(() => expect(server.sent("POST /api/app/projects/AA/repositories/github")).toHaveLength(2));
    expect(server.sent("POST /api/app/projects/AA/repositories/github")[1].body).toEqual({ installationId: "1001", repoId: "5002", pathLimit: null });
    await waitFor(() => expect(server.sent("GET /api/app/projects/AA/repositories/github").length).toBeGreaterThan(1)); // read again
  });

  test("a refused connection shows the server's reason on that installation", async () => {
    open("/p/AA/repos", (s) => s.on("POST /api/app/projects/AA/repositories/github", apiError(409, "conflict", "acme/web is already connected to this project")));
    await userEvent.setup().click(within(await githubCard()).getAllByRole("button", { name: "Connect" })[0]);
    expect(await screen.findByText("acme/web is already connected to this project")).toBeTruthy();
  });

  test("an installation with nothing left to connect says so; one GitHub would not answer for says that", async () => {
    open("/p/AA/repos", (s) =>
      s.on(
        "GET /api/app/projects/AA/repositories/github",
        githubStatus({
          installations: [
            { installationId: "1", account: "empty-org", failed: false, repositories: [] },
            { installationId: "2", account: "broken-org", failed: true, repositories: [] },
          ],
        }),
      ),
    );
    const c = await githubCard();
    expect(within(c).getByText(/Every repository this installation can see is already connected here/)).toBeTruthy();
    expect(within(c).getByText("Could not load this installation's repositories from GitHub.")).toBeTruthy();
  });

  test.each([
    ["?github=connected", "GitHub connected. Choose the repositories this project uses.", false],
    ["?github=repo_connected", "Repository connected.", false],
    ["?github_error=not_yours", "GitHub says you cannot administer that installation, so it was not connected.", true],
    ["?github_error=taken", "That GitHub installation is already connected to another workspace.", true],
    ["?github_error=owner_only", "Only workspace owners can connect GitHub.", true],
    ["?github_error=connect_failed&github_msg=acme%2Fweb%20is%20private", "acme/web is private", true],
    ["?github_error=something_new", "Something went wrong talking to GitHub. Try again in a minute.", true],
  ])("coming back from GitHub with %s says %s", async (query, text, bad) => {
    open(`/p/AA/repos${query}`);
    await githubCard();
    const note = (await screen.findAllByRole("status")).find((n) => n.tagName === "P") as HTMLElement;
    expect(note.textContent).toBe(text);
    expect(note.className).toContain(bad ? "text-danger" : "text-ok");
  });

  test("when the status cannot be read the card says so instead of hanging", async () => {
    open("/p/AA/repos", (s) => s.on("GET /api/app/projects/AA/repositories/github", apiError(403, "forbidden", "No")));
    expect(await screen.findByText("Could not load the GitHub connection. Try again in a moment.")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Repositories" })).toBeTruthy(); // the page is still there
  });
});
