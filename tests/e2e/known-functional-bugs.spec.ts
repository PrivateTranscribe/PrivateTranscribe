import { expect, test } from "./fixtures/electron-app";

// Review findings from 2026-09-10. Each expected failure is enabled only after
// its setup succeeds. Remove test.fail when fixing the corresponding defect.
// Download and disk failures are simulated at IPC; no real downloads or deletes.

test.describe("duplicate login launch", () => {
  test.use({ appArgs: ["--launch-at-login", "--startup-mode=tray"] });

  test("keeps an existing tray session hidden on another login launch", async ({
    electronApp,
    overlayWindow,
  }) => {
    await expect(overlayWindow.locator("#root")).not.toBeEmpty();
    const visible = () =>
      electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.webContents.getURL().includes("panel=true"))
          ?.isVisible()
      );
    expect(await visible()).toBe(false);
    await electronApp.evaluate(async ({ app }) => {
      app.emit(
        "second-instance",
        {},
        [process.execPath, "--launch-at-login", "--startup-mode=tray"],
        process.cwd()
      );
      await new Promise((resolve) => setImmediate(resolve));
    });
    test.fail(true, "main.js treats automatic second launches as explicit open requests");
    expect(await visible()).toBe(false);
  });
});

test.describe("model download failures", () => {
  test.use({ useThrowawayHome: true });

  test("keeps download controls after leaving and returning to Dictation", async ({
    electronApp,
    controlPanel,
  }) => {
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("download-whisper-model");
      ipcMain.handle("download-whisper-model", () => new Promise(() => {}));
    });
    await controlPanel.evaluate(() => localStorage.setItem("useLocalWhisper", "true"));
    await controlPanel.reload({ waitUntil: "domcontentloaded" });
    await controlPanel.getByRole("button", { name: "Dictation", exact: true }).click();
    await controlPanel.getByRole("button", { name: "Download", exact: true }).first().click();
    await expect(controlPanel.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
    await controlPanel.getByRole("button", { name: "Home", exact: true }).click();
    await controlPanel.getByRole("button", { name: "Dictation", exact: true }).click();
    await expect(
      controlPanel.getByRole("button", { name: "Download", exact: true }).first()
    ).toBeVisible();
    test.fail(true, "useModelDownload loses the active job on unmount and never restores it");
    await expect(controlPanel.getByRole("button", { name: "Cancel", exact: true })).toBeVisible({
      timeout: 1500,
    });
  });

  test("shows the reason a model download failed", async ({ electronApp, controlPanel }) => {
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("download-whisper-model");
      ipcMain.handle("download-whisper-model", () => ({
        success: false,
        error: "Audit simulated disk full",
      }));
    });
    await controlPanel.evaluate(() => localStorage.setItem("useLocalWhisper", "true"));
    await controlPanel.reload({ waitUntil: "domcontentloaded" });
    await controlPanel.getByRole("button", { name: "Dictation", exact: true }).click();
    await controlPanel.getByRole("button", { name: "Download", exact: true }).first().click();
    await expect(controlPanel.getByRole("button", { name: /Retry/ }).first()).toBeVisible();
    test.fail(true, "useModelDownload owns alert state but never renders or exposes its dialog");
    await expect(controlPanel.getByText(/Audit simulated disk full/)).toBeVisible({
      timeout: 1500,
    });
  });
});

test("preserves the history limit when deleting older entries fails", async ({
  electronApp,
  controlPanel,
}) => {
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("db-trim-transcriptions");
    ipcMain.handle("db-trim-transcriptions", () => ({
      success: false,
      error: "Audit simulated database failure",
    }));
    // Prevent the subsequent set-history-limit call from retrying a real trim.
    ipcMain.removeHandler("set-history-limit");
    ipcMain.handle("set-history-limit", () => ({
      success: false,
      error: "Audit simulated database failure",
    }));
  });
  await controlPanel.getByRole("button", { name: "Settings", exact: true }).click();
  const input = controlPanel.getByRole("textbox", { name: "History limit" });
  await expect(input).toHaveValue("50");
  await input.fill("10");
  await input.press("Enter");
  await controlPanel.getByRole("button", { name: "Confirm & delete", exact: true }).click();
  await expect(
    controlPanel.getByRole("button", { name: "Confirm & delete", exact: true })
  ).toHaveCount(0);
  test.fail(true, "HistoryLimitInput ignores success:false and commits the new setting");
  expect(await controlPanel.evaluate(() => localStorage.getItem("historyLimit"))).toBe("50");
});
