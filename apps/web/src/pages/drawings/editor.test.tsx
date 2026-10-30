import { describe, expect, test, vi } from "vitest";
import { configure, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Drawing } from "@wheelhouse/api-client";
import { apiError, renderApp, type FakeServer } from "../../test/harness";

// Excalidraw needs a real browser; the canvas is replaced by two buttons that report a drawn change, as the real one does after its debounce.
vi.mock("./excalidraw-canvas", () => ({
  default: ({ scene, theme, onSave }: { scene: string; theme: string; onSave: (body: string, thumbnail: string) => void }) => (
    <div data-testid="canvas" data-theme={theme} data-scene={scene}>
      <button onClick={() => onSave('{"elements":["a"]}', "<svg>a</svg>")}>draw a</button>
      <button onClick={() => onSave('{"elements":["b"]}', "<svg>b</svg>")}>draw b</button>
    </div>
  ),
}));

// The editor loads lazily, so the first render can take longer than the default wait.
configure({ asyncUtilTimeout: 5000 });
const url = (path: string) => `/api/app/teams/AA/${path}`;
const PATH = url("drawings/dr-arch");
const drawing = (over: Partial<Drawing> = {}) => ({ id: "dr-arch", slug: "architecture", title: "Architecture", kind: "drawing", body: '{"elements":[]}', thumbnail: null, version: 3, ...over }) as unknown as Drawing;
const open = (setup: (s: FakeServer) => unknown = () => {}) =>
  renderApp("/t/AA/drawings/dr-arch", (s) => {
    s.on(`GET ${PATH}`, () => ({ drawing: drawing() }));
    setup(s);
  });

describe("the drawing editor", () => {
  test("opens the stored scene in the canvas, with the title and a way back", async () => {
    open();
    const canvas = await screen.findByTestId("canvas");
    expect(canvas.getAttribute("data-scene")).toBe('{"elements":[]}');
    expect(["light", "dark"]).toContain(canvas.getAttribute("data-theme"));
    expect((screen.getByLabelText("Drawing title") as HTMLInputElement).value).toBe("Architecture");
    expect(screen.getByRole("link", { name: "← Drawings" }).getAttribute("href")).toBe("/w/ae/t/AA/drawings");
  });

  test("a change saves the scene and its SVG thumbnail with the version, and the next save carries the new version", async () => {
    const { server } = open((s) => s.on(`PATCH ${PATH}`, () => ({ drawing: drawing({ version: 4 }) })));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "draw a" }));
    await waitFor(() => expect(server.sent(`PATCH ${PATH}`)).toHaveLength(1));
    expect(server.sent(`PATCH ${PATH}`)[0].body).toEqual({ body: '{"elements":["a"]}', thumbnail: "<svg>a</svg>", version: 3 });
    await user.click(screen.getByRole("button", { name: "draw b" }));
    await waitFor(() => expect(server.sent(`PATCH ${PATH}`)).toHaveLength(2));
    expect(server.sent(`PATCH ${PATH}`)[1].body).toMatchObject({ version: 4 });
  });

  test("a refused save (someone else changed it) shows the reload message and stops saving", async () => {
    const { server } = open((s) => s.on(`PATCH ${PATH}`, apiError(409, "conflict", "Doc was changed.")));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "draw a" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Someone changed this drawing. Reload");
    await user.click(screen.getByRole("button", { name: "draw b" }));
    expect(server.sent(`PATCH ${PATH}`)).toHaveLength(1); // nothing is overwritten
  });

  test("editing the title saves it with the version", async () => {
    const { server } = open((s) => s.on(`PATCH ${PATH}`, () => ({ drawing: drawing({ version: 4, title: "System map" }) })));
    const user = userEvent.setup();
    const input = await screen.findByLabelText("Drawing title");
    await user.clear(input);
    await user.type(input, "System map");
    await user.tab();
    await waitFor(() => expect(server.sent(`PATCH ${PATH}`)).toHaveLength(1));
    expect(server.sent(`PATCH ${PATH}`)[0].body).toEqual({ title: "System map", version: 3 });
  });
});
