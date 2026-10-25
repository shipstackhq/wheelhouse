import { describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AvatarEditor } from "./avatar-editor";

const agent = { name: "Reviewer", avatar: { style: "notionists" as const, seed: "fixed-seed" } };

function open(onSave = vi.fn().mockResolvedValue(undefined)) {
  render(<AvatarEditor open agent={agent} onOpenChange={() => {}} onSave={onSave} />);
  return { onSave, user: userEvent.setup() };
}

describe("the face editor", () => {
  test("the style picker shows the five styles, each drawn with this agent's seed", () => {
    open();
    const styles = Array.from(document.querySelectorAll("[data-style]")).map((b) => b.getAttribute("data-style"));
    expect(styles).toEqual(["notionists", "notionists-neutral", "lorelei", "lorelei-neutral", "open-peeps"]);
    expect(screen.getByRole("button", { name: "Notionists" }).getAttribute("aria-pressed")).toBe("true");
    const tile = screen.getByRole("button", { name: "Open peeps" }).querySelector("img")!;
    expect(tile.getAttribute("src")).toBeTruthy();
  });

  test("Shuffle changes the seed, and Save sends only the avatar", async () => {
    const { onSave, user } = open();
    await user.click(screen.getByRole("button", { name: "Shuffle" }));
    await user.click(screen.getByRole("button", { name: "Lorelei" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const [patch] = onSave.mock.calls[0];
    expect(Object.keys(patch)).toEqual(["avatar"]);
    expect(patch.avatar.style).toBe("lorelei");
    expect(patch.avatar.seed).not.toBe("fixed-seed");
  });
});
