import { describe, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Drawing, DrawingListItem } from "@wheelhouse/api-client";
import { apiError, renderApp, type FakeServer } from "../../test/harness";

const HOME = "/t/AA/drawings";
const url = (path: string) => `/api/app/teams/AA/${path}`;
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>';

const item = (over: Partial<DrawingListItem> = {}): DrawingListItem => ({
  id: "dr-arch",
  slug: "architecture",
  title: "Architecture",
  version: 3,
  updatedAt: "2026-10-16T00:00:00.000Z",
  thumbnail: SVG,
  updatedByName: "Ada Lovelace",
  ...over,
});
const DRAWINGS = [item(), item({ id: "dr-flow", slug: "flow", title: "Signup flow", thumbnail: null, updatedByName: "Agent" })];
const open = (setup: (s: FakeServer) => unknown = () => {}) => renderApp(HOME, setup);
const serve = (s: FakeServer, drawings = DRAWINGS) => s.on(`GET ${url("drawings")}`, { drawings });

describe("the drawings grid", () => {
  test("lists the team's drawings as cards with preview, name and who edited when", async () => {
    open((s) => serve(s));
    const card = (await screen.findByText("Architecture")).closest("li")!;
    expect(within(card).getByText(/Edited by Ada Lovelace on/)).toBeTruthy();
    expect(card.querySelector("img")!.getAttribute("src")).toContain("data:image/svg+xml");
    expect(within(card).getByRole("link", { name: "Open Architecture" }).getAttribute("href")).toBe("/w/ae/t/AA/drawings/dr-arch");
    const other = screen.getByText("Signup flow").closest("li")!;
    expect(other.querySelector("img")).toBeNull(); // no thumbnail yet
    expect(within(other).getByText(/Edited by Agent/)).toBeTruthy();
    expect(document.querySelector("h1")?.textContent).toBe("Drawings");
  });

  test("asks only for this team's drawings, and never loads the editor", async () => {
    const { server } = open((s) => serve(s));
    await screen.findByText("Architecture");
    expect(server.requests).toContain(`GET ${url("drawings")}`);
    expect(server.requests.filter((r) => r.includes("/drawings/"))).toEqual([]);
  });

  test("with none it explains drawings and offers New drawing, without a search box", async () => {
    open((s) => serve(s, []));
    await screen.findByText(/No drawings yet/);
    expect(screen.getByRole("button", { name: "New drawing" })).toBeTruthy();
    expect(screen.queryByLabelText("Search drawings by name")).toBeNull();
  });

  test("search filters by name and says when nothing matches", async () => {
    open((s) => serve(s));
    const user = userEvent.setup();
    await screen.findByText("Architecture");
    await user.type(screen.getByLabelText("Search drawings by name"), "signup");
    expect(screen.queryByText("Architecture")).toBeNull();
    expect(screen.getByText("Signup flow")).toBeTruthy();
    await user.clear(screen.getByLabelText("Search drawings by name"));
    await user.type(screen.getByLabelText("Search drawings by name"), "zzz");
    expect(await screen.findByText(/No drawings match/)).toBeTruthy();
  });

  test("New drawing creates an empty drawing and opens it", async () => {
    const created = { id: "dr-new", slug: "untitled-drawing", title: "Untitled drawing", kind: "drawing", thumbnail: null, version: 1 } as unknown as Drawing;
    const { server, at } = open((s) => {
      serve(s);
      s.on(`POST ${url("drawings")}`, { drawing: created });
    });
    const user = userEvent.setup();
    await screen.findByText("Architecture");
    await user.click(screen.getByRole("button", { name: "New drawing" }));
    await waitFor(() => expect(at()).toBe("/t/AA/drawings/dr-new"));
    expect(server.sent(`POST ${url("drawings")}`)[0].body).toEqual({ title: "Untitled drawing" });
  });

  test("rename sends the new title with the version it was read at", async () => {
    const { server } = open((s) => {
      serve(s);
      s.on(`PATCH ${url("drawings/dr-arch")}`, { drawing: {} });
    });
    const user = userEvent.setup();
    await screen.findByText("Architecture");
    await user.click(screen.getByRole("button", { name: "Rename Architecture" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox"), "System map");
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(server.sent(`PATCH ${url("drawings/dr-arch")}`)).toHaveLength(1));
    expect(server.sent(`PATCH ${url("drawings/dr-arch")}`)[0].body).toEqual({ title: "System map", version: 3 });
  });

  test("a rename refused because the drawing changed shows the message", async () => {
    open((s) => {
      serve(s);
      s.on(`PATCH ${url("drawings/dr-arch")}`, apiError(409, "conflict", "Doc was changed. Re-read and retry."));
    });
    const user = userEvent.setup();
    await screen.findByText("Architecture");
    await user.click(screen.getByRole("button", { name: "Rename Architecture" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox"), "X");
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));
    expect((await screen.findByRole("alert")).textContent).toContain("was changed");
  });

  test("delete asks first, then removes the drawing", async () => {
    const { server } = open((s) => {
      serve(s);
      s.on(`DELETE ${url("drawings/dr-flow")}`, { ok: true });
    });
    const user = userEvent.setup();
    await screen.findByText("Signup flow");
    await user.click(screen.getByRole("button", { name: "Delete Signup flow" }));
    expect(server.sent(`DELETE ${url("drawings/dr-flow")}`)).toHaveLength(0);
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(server.sent(`DELETE ${url("drawings/dr-flow")}`)).toHaveLength(1));
  });
});
