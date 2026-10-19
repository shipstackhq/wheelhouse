import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const WEB = path.join(__dirname, "..");
const read = (...p: string[]) => fs.readFileSync(path.join(WEB, ...p), "utf8");

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
