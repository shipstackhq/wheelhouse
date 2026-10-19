import tsPlugin from "@typescript-eslint/eslint-plugin";
import reactHooks from "eslint-plugin-react-hooks";

// The repository is a pnpm workspace: apps/api (NestJS), apps/web (React, Vite), packages/core and packages/api-client.
// TypeScript rules apply everywhere; the React hooks rules apply to the React app only.
export default [
  { ignores: ["**/node_modules/**", "**/dist/**", ".work/**", "tests/contract/.work/**", "**/*.tsbuildinfo"] },
  ...tsPlugin.configs["flat/recommended"],
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
];
