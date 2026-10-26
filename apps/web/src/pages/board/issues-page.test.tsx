import { beforeEach, describe, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../../test/harness";

beforeEach(() => {
  localStorage.removeItem("wh:layout:AA");
  localStorage.removeItem("wh:layout:BB");
});

/** The layout switcher lives in the Display menu, so open that first (and close it again, so the list stays clickable). */
const toggle = () => within(screen.getByRole("group", { name: "Layout" }));
const openDisplay = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: "Display options" }));
  return toggle();
};
const closeDisplay = async (user: ReturnType<typeof userEvent.setup>) => user.keyboard("{Escape}");
const isBoard = () => document.querySelector("[data-column]") !== null;
const isList = () => screen.queryAllByRole("region").length > 0 && !isBoard();

describe("the team page's layout", () => {
  test("opens as a list, says which layout is on, and the page is named Issues", async () => {
    renderApp("/t/AA");
    await screen.findByText("Write the plan");
    expect(isList()).toBe(true);
    await openDisplay(userEvent.setup());
    expect(toggle().getByRole("button", { name: "List" }).getAttribute("aria-pressed")).toBe("true");
    expect(toggle().getByRole("button", { name: "Board" }).getAttribute("aria-pressed")).toBe("false");
    await closeDisplay(userEvent.setup());
    expect(screen.getByRole("heading", { level: 1, name: "Alpha" })).toBeTruthy();
  });

  test("the board is the same issues in a column per status; the choice is remembered and the list comes back the same way", async () => {
    const user = userEvent.setup();
    const first = renderApp("/t/AA");
    await screen.findByText("Write the plan");
    await openDisplay(user);
    await user.click(toggle().getByRole("button", { name: "Board" }));
    await closeDisplay(user);
    await waitFor(() => expect(isBoard()).toBe(true));
    for (const title of ["Write the plan", "Build the board", "Fix the crash", "Ship it"]) expect(screen.getByText(title)).toBeTruthy();
    await openDisplay(user);
    expect(toggle().getByRole("button", { name: "Board" }).getAttribute("aria-pressed")).toBe("true");
    await closeDisplay(user);
    expect(localStorage.getItem("wh:layout:AA")).toBe("board");
    first.unmount();

    renderApp("/t/AA");
    await screen.findByText("Write the plan");
    expect(isBoard()).toBe(true); // remembered
    await openDisplay(user);
    await user.click(toggle().getByRole("button", { name: "List" }));
    await closeDisplay(user);
    await waitFor(() => expect(isList()).toBe(true));
    expect(localStorage.getItem("wh:layout:AA")).toBe("list");
  });

  test("each team has its own choice", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/t/AA");
    await screen.findByText("Write the plan");
    await openDisplay(user);
    await user.click(toggle().getByRole("button", { name: "Board" }));
    await closeDisplay(user);
    await waitFor(() => expect(isBoard()).toBe(true));
    await router.navigate("/w/ae/t/BB");
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Beta" })).toBeTruthy());
    await waitFor(() => expect(isList()).toBe(true)); // Beta has not chosen
    expect(localStorage.getItem("wh:layout:BB")).toBeNull();
    await router.navigate("/w/ae/t/AA");
    await waitFor(() => expect(isBoard()).toBe(true)); // Alpha still has the board
  });

  test("an issue opened with ?t= opens in either layout", async () => {
    localStorage.setItem("wh:layout:AA", "board");
    renderApp("/t/AA?t=AA-1");
    await screen.findByRole("dialog");
    expect(isBoard()).toBe(true);
  });
});
