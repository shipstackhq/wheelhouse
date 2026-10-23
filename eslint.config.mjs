import tsPlugin from "@typescript-eslint/eslint-plugin";
import reactHooks from "eslint-plugin-react-hooks";

// The repository is a pnpm workspace: apps/api (NestJS), apps/web (React, Vite), packages/core and packages/api-client.
// TypeScript rules apply everywhere; the React hooks rules apply to the React app only.
export default [
  { ignores: ["**/node_modules/**", "**/dist/**", "next-env.d.ts", ".work/**", "tests/contract/.work/**", "**/*.tsbuildinfo"] },
  ...tsPlugin.configs["flat/recommended"],
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  // A NestJS module (apps/api/src/modules/<area>) is reached only through its index.ts. A relative import that climbs into
  // a sibling module's folder must name its index (or the folder), never a file inside it. Warn now; error when the migration ends
  // (docs/nest-architecture.md). A module's own files import each other with "./".
  {
    files: ["apps/api/src/modules/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "warn",
        {
          patterns: [
            {
              // ../<other>/<file>: a sibling module's file (its index.ts and the folder itself are allowed)
              regex: "^\\.\\./(?!\\.\\./)[^/]+/(?!index(\\.[jt]sx?)?$).+",
              message: "Import another module only through its index.ts (its public surface), never its internals.",
            },
            {
              // ../../modules/<other>/<file>: the same, reached from further down the tree
              regex: "^(\\.\\./)+modules/[^/]+/(?!index(\\.[jt]sx?)?$).+",
              message: "Import another module only through its index.ts (its public surface), never its internals.",
            },
          ],
        },
      ],
    },
  },
];
