import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["packages/*/src/**/*.test.ts", "packages/*/tests/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/eval-harness/fixtures/**",
      "**/dashboard/**", // has its own jsdom-based vite.config.ts + `npm test`
    ],
    testTimeout: 30000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/dist/**"],
    },
  },
});
