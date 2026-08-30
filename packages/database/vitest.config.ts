import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: 2,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
