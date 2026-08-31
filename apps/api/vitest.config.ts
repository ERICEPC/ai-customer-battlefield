import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The official runner gives each PGlite/Nest e2e file its own process.
    // Keep ad-hoc multi-file invocations bounded as an additional safeguard.
    maxWorkers: 1,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
