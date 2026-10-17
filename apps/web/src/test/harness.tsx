import { render } from "@testing-library/react";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { createApiClient, type Me, type Project } from "@wheelhouse/api-client";
import { createServices, ServicesProvider } from "../lib/services";
import { activityEvent, adminTeam, adminTeamDetail, agentsPage, board, graph, serveWidgets, team } from "./data";
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
/** A failure answer in the API's envelope. */
export const apiError = (status: number, code: string, message: string, details?: unknown, headers: Record<string, string> = {}) => json(status, { error: { code, message, details } }, headers);
export const ok = (body: unknown = { ok: true }, status = 200) => json(status, body);

export type Seen = { method: string; url: string; body: unknown; headers: Record<string, string> };
type Handler = (seen: Seen) => Response | unknown | Promise<Response | unknown>;

/** A stand-in for the Nest API: who is signed in, what projects exist, and every request it saw. */
export class FakeServer {
  me: Me | null = ADA;
  projects: Project[] = PROJECTS;
  requests: string[] = [];
  /** Make /api/app/me or /api/app/projects wait for release() (to see the loading state). */
  hold: Promise<void> | null = null;
  /** Make a path fail: a Response, or "network" for a dropped connection. */
  fail: Record<string, Response | "network"> = {};
  /** What the page endpoints answer: "GET /api/app/team" -> a Response, or any value (sent as the 200 JSON body). Matched with the query first, then without. */
  handlers: Record<string, Handler> = {};
  /** Every request with its parsed JSON body, in order. */
  calls: Seen[] = [];
  on(route: string, answer: Handler): this;
  on(route: string, answer: unknown): this;
  on(route: string, answer: unknown) {
    this.handlers[route] = typeof answer === "function" ? (answer as Handler) : () => answer;
    return this;
  }
  /** The requests made to `route` ("POST /api/app/keys"), with their bodies. */
  sent(route: string) {
    return this.calls.filter((c) => `${c.method} ${c.url.split("?")[0]}` === route || `${c.method} ${c.url}` === route);
  }

  fetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    this.requests.push(`${method} ${url}`);
    const seen: Seen = { method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined, headers: Object.fromEntries(new Headers(init?.headers)) };
    this.calls.push(seen);
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
    const handler = this.handlers[`${method} ${url}`] ?? this.handlers[`${method} ${url.split("?")[0]}`];
    if (handler) {
      const answer = await handler(seen);
      return answer instanceof Response ? answer : json(200, answer);
    }
    return json(404, { error: { code: "not_found", message: `fake server has no ${method} ${url}` } });
  };
}

/** A server that answers every page endpoint with believable data; a test overrides what it cares about with `server.on(...)`. */
export function serverWithData() {
  const server = new FakeServer();
  server.on("GET /api/app/team", team());
  server.on("GET /api/app/agents", agentsPage());
  server.on("GET /api/app/invites", { invites: [] });
  server.on("GET /api/app/admin/teams", { teams: [adminTeam()] });
  server.on("GET /api/app/admin/teams/t2", { team: adminTeamDetail() });
  serveWidgets(server);
  for (const key of ["AA", "BB"]) {
    server.on(`GET /api/app/projects/${key}/board`, board(key));
    server.on(`GET /api/app/projects/${key}/queue`, { bots: [] });
    server.on(`GET /api/app/projects/${key}/graph`, graph(key));
    server.on(`GET /api/app/projects/${key}/activity`, { events: [activityEvent()] });
  }
  return server;
}

/** Render the real routes at `path`, as a browser would, against the fake server. */
export function renderApp(path: string, setup: (server: FakeServer) => void = () => {}) {
  const server = serverWithData();
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
export function renderIn(ui: React.ReactNode, path = "/", server = serverWithData()) {
  const services = createServices({ api: createApiClient({ fetch: server.fetch }) });
  const router = createMemoryRouter([{ path: "*", element: ui }], { initialEntries: [path] });
  const view = render(
    <ServicesProvider services={services}>
      <RouterProvider router={router} />
    </ServicesProvider>,
  );
  return { ...view, router, services, server };
}

/** A board that changes: tests move tickets in `state`, and the fake server answers with it (as the real one would after a change). */
export function liveBoard(server: FakeServer, key: string, start: BoardView) {
  const state = { board: start };
  server.on(`GET /api/app/projects/${key}/board`, () => state.board);
  return state;
}
import type { BoardView } from "@wheelhouse/api-client";
