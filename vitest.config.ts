import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws outside a React Server Component graph; unit tests
      // run in plain Node, so swap it for its empty react-server entry.
      "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/proxy/**/*.ts"],
      exclude: ["src/proxy/**/*.test.ts"],
      reporter: ["text", "json-summary"],
      // Gate: at least 90% of lines in the proxy core must be covered.
      thresholds: { lines: 90 },
    },
  },
});
