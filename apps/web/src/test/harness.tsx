import { render } from "@testing-library/react";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { createApiClient, type Me, type Project } from "@wheelhouse/api-client";
import { createServices, ServicesProvider } from "../lib/services";
import { buildRoutes } from "../routes/router";

export const ADA: Me = {
  user: { id: "u1", name: "Ada Lovelace", email: "ada@example.test" },
  team: { id: "t1", name: "Analytical Engines" },
  role: "owner",
  tags: ["eng"],
  isInstanceAdmin: false,
  csrfToken: "csrf-ada",
};

export const project = (key: string, name = `${key} project`): Project => ({ id: `id-${key}`, key, name, description: "", createdAt: "2026-10-16T00:00:00.000Z" });
export const PROJECTS = [project("AA", "Alpha"), project("BB", "Beta")];

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
export const signedOut = () => json(401, { error: { code: "unauthorized", message: "Not authenticated" } });

/** A stand-in for the Nest API: who is signed in, what projects exist, and every request it saw. */
export class FakeServer {
  me: Me | null = ADA;
  projects: Project[] = PROJECTS;
  requests: string[] = [];
  /** Make /api/app/me or /api/app/projects wait for release() (to see the loading state). */
  hold: Promise<void> | null = null;
  /** Make a path fail: a Response, or "network" for a dropped connection. */
  fail: Record<string, Response | "network"> = {};

  fetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    this.requests.push(`${method} ${url}`);
    const failure = this.fail[url];
    if (failure === "network") throw new TypeError("Failed to fetch");
    if (failure) return failure.clone();
    if (this.hold) await this.hold;
    if (url === "/api/app/me" && method === "GET") return this.me ? json(200, this.me) : signedOut();
    if (url === "/api/app/projects" && method === "GET") return this.me ? json(200, { projects: this.projects }) : signedOut();
    if (url === "/api/app/auth/logout" && method === "POST") {
      this.me = null;
      return json(200, { ok: true });
    }
    return json(404, { error: { code: "not_found", message: `fake server has no ${method} ${url}` } });
  };
}

/** Render the real routes at `path`, as a browser would, against the fake server. */
export function renderApp(path: string, setup: (server: FakeServer) => void = () => {}) {
  const server = new FakeServer();
  setup(server);
  // eslint-disable-next-line prefer-const -- the services need the router to send you to /login, the router needs the services
  let router: ReturnType<typeof createMemoryRouter>;
  const services = createServices({ api: createApiClient({ fetch: server.fetch }), onSignedOut: () => void router.navigate("/login", { replace: true }) });
  router = createMemoryRouter(buildRoutes(services), { initialEntries: [path] });
  const view = render(
    <ServicesProvider services={services}>
      <RouterProvider router={router} />
    </ServicesProvider>,
  );
  return { ...view, router, services, server, at: () => router.state.location.pathname };
}

/** Render one component inside the real data router and services. */
export function renderIn(ui: React.ReactNode, path = "/", server = new FakeServer()) {
  const services = createServices({ api: createApiClient({ fetch: server.fetch }) });
  const router = createMemoryRouter([{ path: "*", element: ui }], { initialEntries: [path] });
  const view = render(
    <ServicesProvider services={services}>
      <RouterProvider router={router} />
    </ServicesProvider>,
  );
  return { ...view, router, services, server };
}
