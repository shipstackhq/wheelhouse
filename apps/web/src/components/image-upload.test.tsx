import { describe, expect, test, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderIn } from "../test/harness";
import { ImageUpload } from "./image-upload";

const upload = (hasImage: boolean, onRemove = vi.fn(async () => {})) =>
  renderIn(<ImageUpload label="Profile picture" preview={<span>pic</span>} hasImage={hasImage} onSave={async () => {}} onRemove={onRemove} />);

describe("the image upload", () => {
  test("clicking the picture opens a menu: upload when there is none, change and remove when there is", async () => {
    const { unmount } = upload(false);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Change profile picture" }));
    expect(await screen.findByRole("menuitem", { name: "Upload image" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Remove" })).toBeNull();
    unmount();
    const onRemove = vi.fn(async () => {});
    upload(true, onRemove);
    await user.click(screen.getByRole("button", { name: "Change profile picture" }));
    expect(await screen.findByRole("menuitem", { name: "Change image" })).toBeTruthy();
    await user.click(screen.getByRole("menuitem", { name: "Remove" }));
    expect(onRemove).toHaveBeenCalledOnce();
  });
});
