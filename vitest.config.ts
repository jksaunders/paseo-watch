import { defineConfig, mergeConfig } from "vitest/config";

const sharedConfig = defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
      exclude: ["**/*.test.ts", "**/*.d.ts", "**/test-helpers.ts"],
    },
  },
});

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      coverage: {
        include: ["src/**/*.ts"],
        exclude: ["src/main.ts", "src/daemon.ts", "src/ui/screen.ts"],
        thresholds: {
          lines: 85,
          functions: 85,
          branches: 70,
          statements: 85,
        },
      },
    },
  }),
);
