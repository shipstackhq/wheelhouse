import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite ships wasm + data files that must be loaded from node_modules at runtime.
  serverExternalPackages: ["@electric-sql/pglite"],
  outputFileTracingIncludes: { "/**": ["./drizzle/**/*"] },
};

export default nextConfig;
