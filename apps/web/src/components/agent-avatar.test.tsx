import { describe, expect, test } from "vitest";
import { render } from "@testing-library/react";
import { AVATAR_STYLES } from "@wheelhouse/shared/agents/avatar";
import { AgentAvatar, avatarUri } from "./agent-avatar";

describe("an agent's face", () => {
  test("the same style and seed give the same SVG; another seed gives another", () => {
    const a = avatarUri({ style: "notionists", seed: "abc" });
    expect(a).toMatch(/^data:image\/svg\+xml;/);
    expect(avatarUri({ style: "notionists", seed: "abc" })).toBe(a);
    expect(avatarUri({ style: "notionists", seed: "xyz" })).not.toBe(a);
    expect(avatarUri({ style: "lorelei", seed: "abc" })).not.toBe(a);
  });

  test("every shared style renders locally, and the alt is the agent's name", () => {
    for (const style of AVATAR_STYLES) expect(avatarUri({ style, seed: "s" })).toMatch(/^data:image\/svg/);
    const img = render(<AgentAvatar avatar={{ style: "open-peeps", seed: "s" }} name="Reviewer" size="lg" />).container.querySelector("img")!;
    expect(img.getAttribute("alt")).toBe("Reviewer");
    expect(img.getAttribute("src")).toBe(avatarUri({ style: "open-peeps", seed: "s" }));
    expect(img.className).toContain("size-14");
  });
});
