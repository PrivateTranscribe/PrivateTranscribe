import fs from "node:fs";
import path from "node:path";
import { cloudFile } from "./fixtures/cloud-file";
import { expect, test } from "./fixtures/electron-app";
const shots = path.resolve("test-results/qa-file-feedback");
const wav = path.resolve("tests/fixtures/multispeaker/control.wav");
const text =
  "The file was transcribed successfully. Keep this copy even if History is unavailable.";
test.beforeAll(() => {
  fs.mkdirSync(shots, { recursive: true });
});

for (const failure of ["response", "rejection"]) {
  test(`a History save ${failure} keeps the completed transcript`, async ({
    controlPanel,
    electronApp,
  }) => {
    await cloudFile(controlPanel, electronApp);
    await electronApp.evaluate(({ ipcMain }, mode) => {
      ipcMain.removeHandler("db-save-transcription");
      ipcMain.handle("db-save-transcription", () => {
        if (mode === "rejection") throw new Error("History unavailable");
        return { success: false, error: "History unavailable" };
      });
    }, failure);
    await controlPanel.locator('input[type="file"]').setInputFiles(wav);
    await expect
      .poll(() => controlPanel.evaluate(() => typeof (window as any).__finishTranscription))
      .toBe("function");
    await controlPanel.evaluate((value) => (window as any).__finishTranscription(value), text);
    await expect(controlPanel.locator("textarea")).toHaveValue(text);
    await expect(controlPanel.getByText("Not saved to History", { exact: true })).toBeVisible();
    await expect(controlPanel.getByRole("heading", { name: "Transcription failed" })).toHaveCount(
      0
    );
    await expect(controlPanel.getByText("Transcription complete", { exact: true })).toHaveCount(0);
    await controlPanel.locator("textarea").scrollIntoViewIfNeeded();
    await controlPanel.screenshot({
      path: path.join(shots, `after-save-${failure}.png`),
      animations: "disabled",
    });
    await expect(controlPanel.getByRole("button", { name: "Copy", exact: true })).toBeEnabled();
    await expect(controlPanel.getByRole("button", { name: "TXT", exact: true })).toBeEnabled();
    await controlPanel.getByRole("button", { name: "New file", exact: true }).click();
    await expect(controlPanel.getByText("Not saved to History", { exact: true })).toHaveCount(0);
  });
}

test("a delayed History save keeps the transcript usable", async ({
  controlPanel,
  electronApp,
}) => {
  await cloudFile(controlPanel, electronApp);
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("db-save-transcription");
    ipcMain.handle(
      "db-save-transcription",
      () =>
        new Promise((resolve) => {
          (globalThis as any).__finishHistorySave = resolve;
        })
    );
  });
  await controlPanel.locator('input[type="file"]').setInputFiles(wav);
  await expect
    .poll(() => controlPanel.evaluate(() => typeof (window as any).__finishTranscription))
    .toBe("function");
  await controlPanel.evaluate((value) => (window as any).__finishTranscription(value), text);
  await expect
    .poll(() => electronApp.evaluate(() => typeof (globalThis as any).__finishHistorySave))
    .toBe("function");
  await expect(controlPanel.locator("textarea")).toHaveValue(text);
  await expect(controlPanel.getByText("Saving to History…", { exact: true })).toBeVisible();
  await expect(controlPanel.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
  await expect(controlPanel.getByRole("button", { name: "Copy", exact: true })).toBeEnabled();
  await expect(controlPanel.getByRole("button", { name: "TXT", exact: true })).toBeEnabled();
  await controlPanel.locator("textarea").scrollIntoViewIfNeeded();
  await controlPanel.screenshot({
    path: path.join(shots, "after-history-saving.png"),
    animations: "disabled",
  });
  await electronApp.evaluate(() => (globalThis as any).__finishHistorySave({ success: false }));
  await expect(controlPanel.getByText("Not saved to History", { exact: true })).toBeVisible();
  await expect(controlPanel.locator("textarea")).toHaveValue(text);
});

test("a late History failure cannot change the next file", async ({
  controlPanel,
  electronApp,
}) => {
  await cloudFile(controlPanel, electronApp);
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("db-save-transcription");
    ipcMain.handle(
      "db-save-transcription",
      () =>
        new Promise((resolve) => {
          (globalThis as any).__finishOldSave = resolve;
        })
    );
  });
  await controlPanel.locator('input[type="file"]').setInputFiles(wav);
  await expect
    .poll(() => controlPanel.evaluate(() => typeof (window as any).__finishTranscription))
    .toBe("function");
  await controlPanel.evaluate((value) => (window as any).__finishTranscription(value), text);
  await expect(controlPanel.locator("textarea")).toHaveValue(text);
  await expect(controlPanel.getByText("Saving to History…", { exact: true })).toBeVisible();
  await controlPanel.getByRole("button", { name: "New file", exact: true }).click();
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("db-save-transcription");
    ipcMain.handle("db-save-transcription", () => ({ success: true }));
  });
  await controlPanel.evaluate(() => {
    (window as any).__finishTranscription = undefined;
  });
  await controlPanel.locator('input[type="file"]').setInputFiles(wav);
  await expect
    .poll(() => controlPanel.evaluate(() => typeof (window as any).__finishTranscription))
    .toBe("function");
  await controlPanel.evaluate(() =>
    (window as any).__finishTranscription("This is the next file.")
  );
  await expect(controlPanel.locator("textarea")).toHaveValue("This is the next file.");
  await electronApp.evaluate(() => (globalThis as any).__finishOldSave({ success: false }));
  await expect(controlPanel.getByText("Not saved to History", { exact: true })).toHaveCount(0);
  await expect(controlPanel.locator("textarea")).toHaveValue("This is the next file.");
});
