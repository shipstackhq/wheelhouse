import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { Markdown } from "./markdown";

const renderDiagram = vi.fn(async (_id: string, code: string) => {
  if (code.includes("oops")) throw new Error("parse error");
  return { svg: `<svg data-testid="diagram"><text>${code}</text></svg>` };
});
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: renderDiagram } }));

describe("mermaid in markdown", () => {
  test("a mermaid block is drawn as a diagram; other code stays code", async () => {
    render(<Markdown>{"```mermaid\ngraph TD; A-->B\n```\n\n```ts\nconst x = 1;\n```"}</Markdown>);
    await waitFor(() => expect(screen.getByRole("img", { name: "Diagram" })).toBeTruthy());
    expect(renderDiagram).toHaveBeenCalledWith(expect.any(String), "graph TD; A-->B");
    expect(screen.getByText("const x = 1;").closest("pre")).toBeTruthy();
  });

  test("a block mermaid cannot parse stays as code", async () => {
    render(<Markdown>{"```mermaid\noops\n```"}</Markdown>);
    await waitFor(() => expect(renderDiagram).toHaveBeenCalledWith(expect.any(String), "oops"));
    expect(screen.queryByRole("img", { name: "Diagram" })).toBeNull();
    expect(screen.getByText("oops").closest("pre")).toBeTruthy();
  });
});
