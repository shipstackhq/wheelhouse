import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      "**/dist/**",
    ],
  },
  // apps/web is a Vite app, not Next: plain <a> and the Next page rules do not apply there.
  { files: ["apps/web/**"], rules: { "@next/next/no-html-link-for-pages": "off" } },
];

export default eslintConfig;
