import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Dev: the browser talks to this server only, and `/api` and `/mcp` are forwarded to the Nest app (VITE_API_TARGET, default
 * http://127.0.0.1:3460). `changeOrigin` stays off on purpose: the API's CSRF check compares the browser's Origin with the Host
 * it receives, and the Host must still be the one the browser used. Server-sent events pass through unbuffered.
 */
const api = process.env.VITE_API_TARGET ?? "http://127.0.0.1:3460";
const proxy = { "/api": { target: api, changeOrigin: false }, "/mcp": { target: api, changeOrigin: false } };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Tailwind runs through its Vite plugin. An inline (even empty) PostCSS config stops Vite searching upwards and finding the
  // Next app's postcss.config.mjs in the repository root, which is for a different toolchain.
  css: { postcss: {} },
  // Reachable from the network as this machine's .local name, not only localhost.
  server: { port: 5173, host: true, allowedHosts: [".local"], proxy },
  preview: { port: 4173, proxy },
  build: { sourcemap: false },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    // jsdom renders on the two-core CI runner run many times slower than locally (about 120 ms became over 5 s), and which test it hits changes from run to run.
    testTimeout: process.env.CI ? 15_000 : 5_000,
  },
});
