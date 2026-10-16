import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const WEB = path.join(__dirname, "..");
const NEXT = path.join(WEB, "..", "..", "src", "app");
const read = (...p: string[]) => fs.readFileSync(path.join(WEB, ...p), "utf8");
const hasNext = fs.existsSync(path.join(NEXT, "globals.css"));

describe("carried over from the Next app unchanged (while both exist)", () => {
  test.skipIf(!hasNext)("the stylesheet is byte for byte the Next app's, so dark mode, density and every token are the same", () => {
    expect(read("src", "app.css")).toBe(fs.readFileSync(path.join(NEXT, "globals.css"), "utf8"));
  });

  test.skipIf(!hasNext)("the theme script that runs before first paint is the Next app's", () => {
    const layout = fs.readFileSync(path.join(NEXT, "layout.tsx"), "utf8");
    const next = /const themeScript = `(.+?)`;/s.exec(layout)![1];
    expect(read("index.html")).toContain(next);
  });

  test.skipIf(!hasNext)("the icons are the Next app's", () => {
    expect(read("public", "icon.svg")).toBe(fs.readFileSync(path.join(NEXT, "icon.svg"), "utf8"));
    expect(read("public", "icon-maskable.svg")).toBe(fs.readFileSync(path.join(WEB, "..", "..", "public", "icon-maskable.svg"), "utf8"));
  });

  test.skipIf(!hasNext)("the manifest says what the Next app's does", () => {
    const manifest = JSON.parse(read("public", "manifest.webmanifest"));
    const next = fs.readFileSync(path.join(NEXT, "manifest.ts"), "utf8");
    for (const key of ["name", "short_name", "description", "start_url", "scope", "display", "background_color", "theme_color"]) {
      expect(next).toContain(`"${manifest[key]}"`);
    }
  });
});

describe("installable", () => {
  const manifest = JSON.parse(read("public", "manifest.webmanifest"));

  test("the manifest has what a browser needs to offer installation", () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.icons.some((i: { purpose: string }) => i.purpose === "any")).toBe(true);
    expect(manifest.icons.some((i: { purpose: string }) => i.purpose === "maskable")).toBe(true);
    for (const icon of manifest.icons) expect(fs.existsSync(path.join(WEB, "public", icon.src.replace(/^\//, "")))).toBe(true);
  });

  test("the page links the manifest, an icon and the theme colour, which match the manifest", () => {
    const html = read("index.html");
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('<link rel="icon" href="/icon.svg"');
    expect(html).toContain(`<meta name="theme-color" content="${manifest.theme_color}"`);
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1"');
    expect(html).toContain('lang="en"');
  });

  test("the service worker and the offline page are shipped at the root", () => {
    for (const f of ["sw.js", "offline.html"]) expect(fs.existsSync(path.join(WEB, "public", f))).toBe(true);
  });
});
