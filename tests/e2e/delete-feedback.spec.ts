import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";
const shots = path.resolve("test-results/qa-everyday-feedback");
const transcript =
  "Send the revised proposal on Monday. Keep the introduction short and include the updated price.";
test.beforeAll(() => {
  fs.mkdirSync(shots, { recursive: true });
});
async function seed(page: Page) {
  await page.evaluate(async (text) => {
    await window.electronAPI.saveTranscription(text, 20);
  }, transcript);
  await expect(page.getByText(transcript, { exact: true })).toBeVisible();
}
test("Home deletion asks first, preserves on cancel, then removes on confirm", async ({
  controlPanel,
}) => {
  await seed(controlPanel);
  await controlPanel.getByRole("button", { name: "Delete transcription", exact: true }).click();
  const dialog = controlPanel.getByRole("dialog", { name: "Delete transcription" });
  await expect(dialog).toBeVisible();
  await expect(controlPanel.getByText(transcript, { exact: true })).toBeVisible();
  await controlPanel.screenshot({
    path: path.join(shots, "after-delete-confirmation.png"),
    animations: "disabled",
  });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(controlPanel.getByText(transcript, { exact: true })).toBeVisible();
  await controlPanel.getByRole("button", { name: "Delete transcription", exact: true }).click();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(controlPanel.getByText(transcript, { exact: true })).toHaveCount(0);
});

for (const destination of ["Home", "History"]) {
  test(`${destination} reports a rejected deletion without losing the text`, async ({
    controlPanel,
    electronApp,
  }) => {
    await seed(controlPanel);
    await controlPanel.getByRole("button", { name: destination, exact: true }).click();
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("db-delete-transcription");
      ipcMain.handle("db-delete-transcription", () => ({ success: false }));
    });
    await controlPanel.getByRole("button", { name: "Delete transcription", exact: true }).click();
    await controlPanel
      .getByRole("dialog")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect(controlPanel.getByText(transcript, { exact: true })).toBeVisible();
    await expect(
      controlPanel.getByText(
        destination === "Home" ? "Delete failed" : "Failed to delete transcription",
        { exact: true }
      )
    ).toBeVisible();
    await expect(controlPanel.getByText("Deleted", { exact: true })).toHaveCount(0);
  });
}

test("History reports a rejected clear without losing its entries", async ({
  controlPanel,
  electronApp,
}) => {
  await seed(controlPanel);
  await controlPanel.getByRole("button", { name: "History", exact: true }).click();
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("db-clear-transcriptions");
    ipcMain.handle("db-clear-transcriptions", () => ({ success: false }));
  });
  await controlPanel.getByRole("button", { name: "Clear All", exact: true }).click();
  await controlPanel
    .getByRole("dialog")
    .getByRole("button", { name: "Clear All", exact: true })
    .click();
  await expect(controlPanel.getByText(transcript, { exact: true })).toBeVisible();
  await expect(controlPanel.getByText("Failed to clear history", { exact: true })).toBeVisible();
  await expect(controlPanel.getByText("History cleared", { exact: true })).toHaveCount(0);
});
