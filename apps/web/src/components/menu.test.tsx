import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Menu, MenuItem, MenuLabel, MenuSeparator, MenuSub } from "./menu";

describe("the menu", () => {
  test("opens from its trigger with a label, items, a divider and a submenu; choosing an item runs it", async () => {
    const onSelect = vi.fn();
    render(
      <Menu trigger={<button>Open</button>}>
        <MenuLabel>Section</MenuLabel>
        <MenuItem onSelect={onSelect}>One</MenuItem>
        <MenuSeparator />
        <MenuSub label="More">
          <MenuItem>Two</MenuItem>
        </MenuSub>
      </Menu>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByText("Section")).toBeTruthy();
    expect(screen.getByRole("separator")).toBeTruthy();
    await user.click(screen.getByRole("menuitem", { name: "More" }));
    expect(await screen.findByRole("menuitem", { name: "Two" })).toBeTruthy();
    await user.click(screen.getByRole("menuitem", { name: "One" }));
    expect(onSelect).toHaveBeenCalledOnce();
  });
});
