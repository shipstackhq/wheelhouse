import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentIcon, CloseIcon, WarningIcon } from "./icons";

describe("icons", () => {
  test("an icon is an SVG hidden from screen readers, sized with the text and sitting inline", () => {
    const html = renderToStaticMarkup(<CloseIcon />);
    expect(html).toMatch(/^<svg /);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("inline-block");
    expect(html).toContain('height="1em"');
  });

  test("a class passed in is added to the defaults, not instead of them", () => {
    const html = renderToStaticMarkup(<WarningIcon className="text-warn" />);
    expect(html).toContain("text-warn");
    expect(html).toContain("inline-block");
  });

  test("different icons draw different shapes", () => {
    expect(renderToStaticMarkup(<AgentIcon />)).not.toBe(renderToStaticMarkup(<CloseIcon />));
  });
});

/** Every `.tsx` file of the app (tests excepted). */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return sources(p);
    return p.endsWith(".tsx") && !p.includes(".test.") ? [p] : [];
  });
}

describe("one icon set", () => {
  const files = sources(join(__dirname, ".."));

  test("no screen draws a glyph or an emoji as an icon: they come from icons.tsx", () => {
    const glyph = /[✕✎⚠☑❝📖▾▸◇✓⋯⚙📄📁☰⤢○✨🎫💬🎉🗺▶▲▼⇆✦🤖]/u;
    const offenders = files.filter((f) => glyph.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  test("the Remix package is imported in one place only", () => {
    const offenders = files.filter((f) => !f.endsWith("icons.tsx") && readFileSync(f, "utf8").includes("@remixicon/react"));
    expect(offenders).toEqual([]);
  });
});
