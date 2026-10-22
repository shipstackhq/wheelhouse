import { describe, expect, test } from "vitest";
import { render } from "@testing-library/react";
import { Avatar, initialsOf } from "./avatar";

describe("initials", () => {
  test("the first and last word's first letters, capital; a single name gives one letter; nothing gives ?", () => {
    expect(initialsOf("Ada Lovelace")).toBe("AL");
    expect(initialsOf("  grace   brewster  hopper ")).toBe("GH");
    expect(initialsOf("ada")).toBe("A");
    expect(initialsOf("")).toBe("?");
    expect(initialsOf("   ")).toBe("?");
  });
});

describe("an avatar", () => {
  test("a person is their initials, with their name as the tooltip; nobody is an empty dashed circle", () => {
    const person = render(<Avatar name="Ada Lovelace" />).container.firstElementChild!;
    expect(person.textContent).toBe("AL");
    expect(person.getAttribute("title")).toBe("Ada Lovelace");
    const nobody = render(<Avatar />).container.firstElementChild!;
    expect(nobody.textContent).toBe("");
    expect(nobody.getAttribute("data-avatar")).toBe("none");
    expect(nobody.getAttribute("class")).toContain("border-dashed");
  });
});
