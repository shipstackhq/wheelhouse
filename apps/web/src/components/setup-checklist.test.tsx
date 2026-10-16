import { describe, expect, test } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderIn } from "../test/harness";
import { SetupChecklist } from "./setup-checklist";
import { board } from "../test/data";

const state = (done: boolean) => {
  const items = board("AA").checklist.items.map((i, n) => ({ ...i, done: done || n < 2 }));
  return { items, done, doneCount: items.filter((i) => i.done).length, total: items.length };
};

describe("the setup checklist on the project page", () => {
  test("while something is left it shows the progress and an action for each undone step, linking to where it is done", () => {
    renderIn(<SetupChecklist state={state(false)} />, "/p/AA");
    expect(screen.getByText("2/5")).toBeTruthy();
    expect(screen.getByRole("img", { name: "2 of 5 setup steps done" })).toBeTruthy();
    const agents = screen.getByRole("link", { name: "Create an API key →" });
    expect(agents.getAttribute("href")).toBe("/agents");
    expect(screen.getByRole("link", { name: "Build the map →" }).getAttribute("href")).toBe("/p/AA/map");
    expect(screen.queryByRole("link", { name: "Connect a repository →" })).toBeNull(); // done steps have no action
  });

  test("once everything is done it is a one-line pill, which opens to the details and collapses again", async () => {
    renderIn(<SetupChecklist state={state(true)} />, "/p/AA");
    const pill = screen.getByRole("button", { name: /Setup complete/ });
    const user = userEvent.setup();
    await user.click(pill);
    expect(screen.getByText("5/5")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Collapse" }));
    expect(screen.getByRole("button", { name: /Setup complete/ })).toBeTruthy();
    expect(within(document.body).queryByText("5/5")).toBeNull();
  });
});
