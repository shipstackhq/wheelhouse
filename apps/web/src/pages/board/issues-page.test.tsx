import { beforeEach, describe, expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../../test/harness";

beforeEach(() => {
  localStorage.removeItem("wh:layout:AA");
  localStorage.removeItem("wh:layout:BB");
});

const toggle = () => within(screen.getByRole("group", { name: "Layout" }));
const isBoard = () => document.querySelector("[data-column]") !== null;
const isList = () => screen.queryAllByRole("region").length > 0 && !isBoard();

describe("the team page's layout", () => {
  test("opens as a list, says which layout is on, and the page is named Issues", async () => {
    renderApp("/t/AA");
    await screen.findByText("Write the plan");
    expect(isList()).toBe(true);
    expect(toggle().getByRole("button", { name: "list" }).getAttribute("aria-pressed")).toBe("true");
    expect(toggle().getByRole("button", { name: "board" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("heading", { level: 1, name: "Alpha" })).toBeTruthy();
  });

  test("the board is the same issues in a column per status; the choice is remembered and the list comes back the same way", async () => {
    const user = userEvent.setup();
    const first = renderApp("/t/AA");
    await screen.findByText("Write the plan");
    await user.click(toggle().getByRole("button", { name: "board" }));
    await waitFor(() => expect(isBoard()).toBe(true));
    for (const title of ["Write the plan", "Build the board", "Fix the crash", "Ship it"]) expect(screen.getByText(title)).toBeTruthy();
    expect(toggle().getByRole("button", { name: "board" }).getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("wh:layout:AA")).toBe("board");
    first.unmount();

    renderApp("/t/AA");
    await screen.findByText("Write the plan");
    expect(isBoard()).toBe(true); // remembered
    await user.click(toggle().getByRole("button", { name: "list" }));
    await waitFor(() => expect(isList()).toBe(true));
    expect(localStorage.getItem("wh:layout:AA")).toBe("list");
  });

  test("each team has its own choice", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/t/AA");
    await screen.findByText("Write the plan");
    await user.click(toggle().getByRole("button", { name: "board" }));
    await waitFor(() => expect(isBoard()).toBe(true));
    await router.navigate("/t/BB");
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Beta" })).toBeTruthy());
    await waitFor(() => expect(isList()).toBe(true)); // Beta has not chosen
    expect(localStorage.getItem("wh:layout:BB")).toBeNull();
    await router.navigate("/t/AA");
    await waitFor(() => expect(isBoard()).toBe(true)); // Alpha still has the board
  });

  test("an issue opened with ?t= opens in either layout", async () => {
    localStorage.setItem("wh:layout:AA", "board");
    renderApp("/t/AA?t=AA-1");
    await screen.findByRole("dialog");
    expect(isBoard()).toBe(true);
  });
});
