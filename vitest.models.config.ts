import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/embedding_models.integration.ts",
      "tests/prepare_models.integration.ts",
      "tests/embedding_runtime_models.integration.ts",
      "tests/real_papers_models.integration.ts",
      "tests/full_pool_models.integration.ts",
      "tests/live_consumers.integration.ts",
      "tests/mcp_semantic.integration.ts",
      "tests/mcp_cli_models.integration.ts",
      "tests/mcp_cache_models.integration.ts",
      "tests/mcp_recovery_models.integration.ts",
      "tests/mcp_interrupted_models.integration.ts",
    ],
    maxWorkers: 1,
    hookTimeout: 600000,
    testTimeout: 180000,
  },
});
