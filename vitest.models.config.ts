import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/embedding_models.integration.ts", "tests/real_papers_models.integration.ts"],
    maxWorkers: 1,
    hookTimeout: 600000,
    testTimeout: 180000,
  },
});
