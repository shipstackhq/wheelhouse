import tsPlugin from "@typescript-eslint/eslint-plugin";
import reactHooks from "eslint-plugin-react-hooks";

// The repository is a pnpm workspace: apps/api (NestJS), apps/web (React, Vite), packages/shared (code both use) and packages/api-client.
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
  // a sibling module's folder must name its index (or the folder), never a file inside it. An error. A module's own files import each
  // other with "./". Test files are exempt: they build their fixtures from other modules' internals (docs/nest-architecture.md).
  {
    files: ["apps/api/src/modules/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // ../<other>/<file>: a sibling module's file (its index.ts, the folder itself and its <area>.module.ts are allowed)
              regex: "^\\.\\./(?!\\.\\./)[^/]+/(?!index(\\.[jt]sx?)?$)(?![a-z-]+\\.module(\\.[jt]sx?)?$).+",
              message: "Import another module only through its index.ts (its public surface), never its internals.",
            },
            {
              // ../../modules/<other>/<file>: the same, reached from further down the tree
              regex: "^(\\.\\./)+modules/[^/]+/(?!index(\\.[jt]sx?)?$)(?![a-z-]+\\.module(\\.[jt]sx?)?$).+",
              message: "Import another module only through its index.ts (its public surface), never its internals.",
            },
          ],
        },
      ],
    },
  },
  // The same rule for a file one folder down inside a module (auth/invites/, issues/cycles/, a module's dto/): there "../<x>" is the
  // module's own, and a sibling module is "../../<other>/<file>".
  {
    files: ["apps/api/src/modules/*/*/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^\\.\\./\\.\\./(?!\\.\\./)[^/]+/(?!index(\\.[jt]sx?)?$)(?![a-z-]+\\.module(\\.[jt]sx?)?$).+",
              message: "Import another module only through its index.ts (its public surface), never its internals.",
            },
            {
              regex: "^(\\.\\./)+modules/[^/]+/(?!index(\\.[jt]sx?)?$)(?![a-z-]+\\.module(\\.[jt]sx?)?$).+",
              message: "Import another module only through its index.ts (its public surface), never its internals.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/api/src/modules/**/*.test.ts"],
    rules: { "no-restricted-imports": "off" },
  },
];
