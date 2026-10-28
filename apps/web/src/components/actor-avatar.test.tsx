import { describe, expect, test } from "vitest";
import { render } from "@testing-library/react";
import { ActorAvatar } from "./actor-avatar";

describe("an actor avatar", () => {
  test("an uploaded image is shown as the picture", () => {
    const el = render(<ActorAvatar actor={{ name: "Ada Lovelace", avatar: { type: "image", url: "/a.png" } }} />).container.firstElementChild!;
    expect(el.getAttribute("src")).toBe("/a.png");
  });

  test("a generated agent face is an svg picture", () => {
    const el = render(<ActorAvatar actor={{ name: "Fern", avatar: { type: "generated", style: "lorelei", seed: "fern" } }} />).container.firstElementChild!;
    expect(el.getAttribute("src")).toMatch(/^data:image\/svg/);
    expect(el.getAttribute("title")).toBe("Fern");
  });

  test("no avatar falls back to initials", () => {
    const el = render(<ActorAvatar actor={{ name: "Ada Lovelace", avatar: null }} />).container.firstElementChild!;
    expect(el.textContent).toBe("AL");
  });
});
