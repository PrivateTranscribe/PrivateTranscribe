import { expect, test } from "./fixtures/electron-app";

test.describe("control panel", () => {
  test("lands on the dashboard once onboarding is complete", async ({ controlPanel }) => {
    await expect(controlPanel.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  });

  test("navigates between sidebar pages", async ({ controlPanel }) => {
    await controlPanel.getByRole("button", { name: "History", exact: true }).click();
    await expect(controlPanel.getByRole("heading", { name: "History" })).toBeVisible();

    await controlPanel.getByRole("button", { name: "Dictionary", exact: true }).click();
    await expect(controlPanel.getByRole("heading", { name: "Dictionary" })).toBeVisible();

    await controlPanel.getByRole("button", { name: "Home", exact: true }).click();
    await expect(controlPanel.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  });

  test("exposes the app version through the preload bridge", async ({ controlPanel }) => {
    // Proves context isolation is wired the way the app expects: the renderer
    // has no Node access but can still reach main through window.electronAPI.
    const result = await controlPanel.evaluate(() => {
      const api = (window as unknown as { electronAPI?: { getAppVersion?: () => Promise<unknown> } })
        .electronAPI;
      return api?.getAppVersion?.() as Promise<{ version?: string } | undefined>;
    });

    expect(result?.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

test.describe("first run", () => {
  test.use({ completeOnboarding: false });

  test("shows the onboarding wizard on a fresh profile", async ({ controlPanel }) => {
    await expect(controlPanel.getByText("Welcome to PrivateTranscribe")).toBeVisible();
  });
});
