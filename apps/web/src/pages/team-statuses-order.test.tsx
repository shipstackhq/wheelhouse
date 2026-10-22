import { describe, expect, test, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { act } from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import { renderApp } from "../test/harness";
import { statusSettings, teamMembers } from "../test/data";

// jsdom has no layout, so a drag cannot be performed. The section hands each role's group a DndContext with its own onDragEnd; these
// tests take those handlers and drop a status the way dnd-kit would, to check the wiring: which group, what order, what is sent.
const handlers = vi.hoisted(() => ({} as Record<string, (e: unknown) => void>));
vi.mock("@dnd-kit/core", async (original) => {
  const real = await original<typeof import("@dnd-kit/core")>();
  return {
    ...real,
    DndContext: (props: { id: string; onDragEnd: (e: DragEndEvent) => void; children: React.ReactNode }) => {
      handlers[props.id] = props.onDragEnd as (e: unknown) => void;
      return props.children;
    },
  };
});

const drop = (group: string, from: string, over: string | null) => act(() => handlers[`statuses-${group}`]({ active: { id: from }, over: over ? { id: over } : null }));
const WITH_TWO_TODO = (all: ReturnType<typeof statusSettings>) => {
  const i = all.findIndex((s) => s.name === "Todo");
  return [...all.slice(0, i + 1), { ...all[i], id: "c-blocked", name: "Blocked", isDefault: false, issueCount: 1, position: 2500 }, ...all.slice(i + 1)];
};
const open = (extra: Parameters<typeof renderApp>[1] = () => {}) =>
  renderApp("/t/AA/settings", (s) => {
    s.on("GET /api/app/teams/AA/members", teamMembers({ myRole: "admin" }));
    s.on("GET /api/app/teams/AA/statuses", { statuses: statusSettings(WITH_TWO_TODO) });
    s.on("PUT /api/app/teams/AA/statuses/order", { statuses: [] });
    extra(s);
  });

describe("dragging a status into order", () => {
  test("dropping one on another of its role sends the whole list in the new order", async () => {
    const { server } = open();
    await screen.findByLabelText("Name of Blocked");
    await drop("todo", "c-blocked", "c-todo");
    await waitFor(() => expect(server.sent("PUT /api/app/teams/AA/statuses/order")).toHaveLength(1));
    expect(server.sent("PUT /api/app/teams/AA/statuses/order")[0].body).toEqual({ ids: ["c-backlog", "c-blocked", "c-todo", "c-progress", "c-review", "c-done", "c-canceled"] });
    await waitFor(() => expect(server.sent("GET /api/app/teams/AA/statuses").length).toBeGreaterThan(1)); // and reads the list again
  });

  test("a drop on itself, outside any status, or on a status of another role sends nothing", async () => {
    const { server } = open();
    await screen.findByLabelText("Name of Blocked");
    await drop("todo", "c-blocked", "c-blocked");
    await drop("todo", "c-blocked", null);
    await drop("todo", "c-blocked", "c-progress");
    expect(server.calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });

  test("a refusal shows above the list", async () => {
    const { apiError } = await import("../test/harness");
    open((s) => s.on("PUT /api/app/teams/AA/statuses/order", apiError(400, "invalid", "Statuses stay grouped by role")));
    await screen.findByLabelText("Name of Blocked");
    await drop("todo", "c-blocked", "c-todo");
    expect((await screen.findByRole("alert")).textContent).toContain("Statuses stay grouped by role");
  });
});
