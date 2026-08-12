import { defineConfig } from "@playwright/test";

/**
 * Playwright config for the Electron end-to-end suite.
 *
 * These tests drive the real app: Electron main process, preload bridge, and the
 * built renderer bundle. They are deliberately separate from the Vitest unit
 * suite (`npm test`), which stays fast and process-free.
 *
 * Run with `npm run test:e2e`. No browser download is required — Playwright
 * launches the Electron binary from node_modules, not Chromium.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.spec\.ts$/,

  // Electron takes a single-instance lock per user-data dir, binds a fixed Vite
  // port in dev mode, and spawns native helpers. Serial execution keeps specs
  // from fighting over the same machine resources.
  workers: 1,
  fullyParallel: false,

  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,

  // App boot pulls in sqlite, the model registry, and window creation.
  timeout: 90_000,
  expect: { timeout: 15_000 },

  globalSetup: "./tests/e2e/global-setup.ts",
  outputDir: "./test-results/e2e",

  reporter: process.env.CI
    ? [["github"], ["html", { outputFolder: "playwright-report", open: "never" }]]
    : [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
});
