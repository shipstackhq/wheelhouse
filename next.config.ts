import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image.
  output: "standalone",
  // PGlite ships wasm + data files that must be loaded from node_modules at runtime.
  serverExternalPackages: ["@electric-sql/pglite"],
  // The workspace package is TypeScript source; Next compiles it with the app.
  transpilePackages: ["@wheelhouse/core"],
  outputFileTracingIncludes: { "/**": ["./packages/core/drizzle/**/*"] },
  async headers() {
    // The invite link's secret is in its fragment; these keep it out of caches, referrers and search indexes.
    return [
      {
        source: "/invite",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
};

export default nextConfig;
