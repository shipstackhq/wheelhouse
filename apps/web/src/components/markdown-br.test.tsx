import { describe, expect, test } from "vitest";
import { render } from "@testing-library/react";
import { Markdown } from "./markdown";

describe("Markdown", () => {
  test("a <br> in a table cell is a line break; other raw HTML stays text", () => {
    const { container } = render(<Markdown>{"| a |\n|---|\n| one<br>two <b>x</b> |"}</Markdown>);
    expect(container.querySelector("td br")).not.toBeNull();
    expect(container.querySelector("td b")).toBeNull();
  });
});
