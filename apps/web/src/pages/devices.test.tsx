import { describe, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DeviceView } from "@wheelhouse/api-client";
import { renderApp } from "../test/harness";

const device: DeviceView = {
  id: "d1",
  name: "MacBook Pro",
  os: "darwin",
  status: "online",
  poolSize: 3,
  chatModel: null,
  daemonVersion: "0.1.0",
  capabilities: {},
  models: ["opus", "sonnet"],
  activeJobs: 0,
  lastSeenAt: null,
  createdAt: "2026-10-20T00:00:00.000Z",
} as DeviceView;

describe("run defaults (WH-123)", () => {
  test("picking a default device, model and effort saves only what was picked", async () => {
    const { server } = renderApp("/settings/devices", (s) => {
      s.on("GET /api/app/devices", { devices: [device] });
      s.on("GET /api/app/run-defaults", { deviceId: null, model: null, effort: null });
      s.on("PUT /api/app/run-defaults", { deviceId: null, model: "opus", effort: null });
    });
    const card = await screen.findByRole("region", { name: "Run defaults" });
    const user = userEvent.setup();
    await user.click(within(card).getByRole("combobox", { name: "Default model" }));
    await user.click(await screen.findByRole("option", { name: "opus" }));
    await waitFor(() => expect(server.sent("PUT /api/app/run-defaults")).toHaveLength(1));
    expect(server.sent("PUT /api/app/run-defaults")[0].body).toEqual({ model: "opus" });
  });
});
