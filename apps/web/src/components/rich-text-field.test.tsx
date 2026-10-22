import { describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RichTextField } from "./rich-text-field";

describe("RichTextField", () => {
  test("shows the text with no box around it, and a click on the text starts editing", async () => {
    render(<RichTextField label="Description" value="Single **sign-on** for everyone" onCommit={() => {}} />);
    const text = screen.getByRole("button", { name: "Edit Description" });
    expect(text.textContent).toBe("Single sign-on for everyone");
    expect(text.querySelector("strong")?.textContent).toBe("sign-on");
    expect(screen.queryByRole("textbox")).toBeNull();
    await userEvent.setup().click(screen.getByText(/everyone/));
    expect(await screen.findByRole("textbox", { name: "Description" })).toBeTruthy();
  });

  test("an empty field shows its placeholder as the thing to click", async () => {
    render(<RichTextField label="Description" placeholder="Add a description" value="" onCommit={() => {}} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Edit Description" }));
    expect(await screen.findByRole("textbox", { name: "Description" })).toBeTruthy();
  });

  test("a read-only field shows its text and cannot be edited", async () => {
    render(<RichTextField label="Description" value="Fixed" readOnly onCommit={() => {}} />);
    await userEvent.setup().click(screen.getByText("Fixed"));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit Description" })).toBeNull();
  });

  test("leaving the field without changing it commits nothing", async () => {
    const onCommit = vi.fn();
    const user = userEvent.setup();
    render(<><RichTextField label="Description" value="Untouched" onCommit={onCommit} /><button>elsewhere</button></>);
    await user.click(screen.getByText("Untouched"));
    await screen.findByRole("textbox", { name: "Description" });
    await user.click(screen.getByRole("button", { name: "elsewhere" }));
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(onCommit).not.toHaveBeenCalled();
  });
});
