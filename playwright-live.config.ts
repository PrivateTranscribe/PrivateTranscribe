import { defineConfig } from "@playwright/test";

/**
 * Config for e2e specs that spend LIVE Claude prompts from the subscription
 * (tests/e2e/*.live.ts). Deliberately separate from playwright.config.ts so
 * the default `npm run test:e2e` suite can never spend a prompt by accident.
 *
 * Run one explicitly, e.g.:
 *   npx playwright test --config playwright-live.config.ts tests/e2e/converse-permission.live.ts
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.live\.ts$/,

  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0, // a retry is a spent prompt; failures are diagnosed, not retried

  timeout: 180_000,
  expect: { timeout: 15_000 },

  globalSetup: "./tests/e2e/global-setup.ts",
  outputDir: "./test-results/e2e-live",
  reporter: [["list"]],
});
