import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.{js,ts}", "src/**/*.test.{js,ts}"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "tests/setup-validation.test.js", // Legacy test, run with npm run test:legacy
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "html", "lcov"],
      include: ["src/**/*.{js,ts}"],
      exclude: [
        "src/**/*.d.ts",
        "src/components/**",
        "src/hooks/**",
        "src/**/*.test.{js,ts}",
        "src/vite.config.mjs",
        "src/eslint.config.js",
        "src/main.css",
        "src/App.jsx",
        "src/ControlPanel.tsx",
      ],
      thresholds: {
        statements: 60,
        branches: 50,
        functions: 50,
        lines: 60,
      },
    },
    testTimeout: 10000,
    hookTimeout: 10000,
    setupFiles: ["./tests/setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
