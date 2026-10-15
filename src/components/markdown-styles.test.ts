import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const css = fs.readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
const dialog = fs.readFileSync(path.join(process.cwd(), "src/app/(app)/p/[key]/ticket-dialog.tsx"), "utf8");

/** The text between the braces of the first rule that starts with `selector {`. */
const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";

test(".md-quiet is a size down from .md and muted", () => {
  const quiet = rule(".md-quiet");
  assert.match(quiet, /text-\[13px\]/, "smaller than .md's text-sm (14px)");
  assert.match(quiet, /text-muted/);
  assert.match(rule(".md"), /text-sm/);
});

test("headings and bold stay at full strength inside a quiet description", () => {
  assert.match(css, /\.md-quiet h1[^{]*\.md-quiet strong\s*\{[^}]*text-fg/);
});

test(".md-quiet comes after .md and outside any @layer, so it actually overrides .md", () => {
  assert.ok(css.indexOf("\n.md-quiet {") > css.indexOf("\n.md {"), "defined after .md");
  // brace-match the @layer blocks and make sure .md-quiet isn't inside one
  let depth = 0;
  const at = css.indexOf("\n.md-quiet {");
  let inLayer = false;
  const layerStart = [...css.matchAll(/@layer [a-z]+ \{/g)].map((m) => m.index!);
  for (const start of layerStart) {
    depth = 0;
    for (let i = css.indexOf("{", start); i < css.length; i++) {
      if (css[i] === "{") depth++;
      if (css[i] === "}" && --depth === 0) {
        if (start < at && at < i) inLayer = true;
        break;
      }
    }
  }
  assert.equal(inLayer, false);
});

test("the ticket description uses it", () => {
  assert.match(dialog, /className="md md-quiet [^"]*"/);
});
