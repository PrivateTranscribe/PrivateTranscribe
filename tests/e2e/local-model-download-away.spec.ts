import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";
import { unlockTesterAccess } from "./fixtures/tester-access";

/**
 * A local AI model is several GB, so people start the download and go to
 * another page. The model used to be switched on only if the picker was still
 * on screen when the download ended. After leaving the page the model sat
 * downloaded but unused, and dictation was pasted without cleanup.
 */

const localId = "qwen3.8-2b-distill-q4_k_m";

test.use({
  useThrowawayHome: true,
  appEnv: { PRIVATETRANSCRIBE_DIAG_DISABLE_OVERLAY_WINDOW: "1" },
});

/** A stand-in download that ends when the test says so. */
async function fakeSlowDownload(electronApp: ElectronApplication) {
  await electronApp.evaluate(({ ipcMain }, modelId) => {
    let downloaded = false;
    const state = globalThis as unknown as { __finishDownload?: () => void };
    ipcMain.removeHandler("model-get-all");
    ipcMain.handle("model-get-all", () => [{ id: modelId, isDownloaded: downloaded }]);
    ipcMain.removeHandler("model-download");
    ipcMain.handle("model-download", async (event, id) => {
      if (id !== modelId) throw new Error("Unexpected model");
      event.sender.send("model-download-progress", {
        modelId: id,
        progress: 50,
        downloadedSize: 656082112,
        totalSize: 1312164224,
      });
      await new Promise<void>((resolve) => {
        state.__finishDownload = resolve;
      });
      downloaded = true;
      return { success: true };
    });
  }, localId);
}

async function finishDownload(electronApp: ElectronApplication) {
  await electronApp.evaluate(() => {
    (globalThis as unknown as { __finishDownload: () => void }).__finishDownload();
  });
}

async function startLocalDownload(page: Page, electronApp: ElectronApplication) {
  await unlockTesterAccess(page);
  await page.getByRole("button", { name: "AI Enhancement", exact: true }).click();
  await page.getByRole("button", { name: "Enable AI enhancement" }).click();
  await page.getByRole("combobox", { name: "Enhance using", exact: true }).click();
  await page.getByRole("option", { name: "Local model", exact: true }).click();
  await page.getByRole("button", { name: "Download", exact: true }).click();
  // The stand-in download is under way once the main process holds its end.
  await expect
    .poll(() =>
      electronApp.evaluate(
        () =>
          typeof (globalThis as unknown as { __finishDownload?: unknown }).__finishDownload ===
          "function"
      )
    )
    .toBe(true);
}

test("a local AI model that finishes downloading on another page is switched on", async ({
  controlPanel: page,
  electronApp,
}) => {
  await fakeSlowDownload(electronApp);
  await startLocalDownload(page, electronApp);

  // Leave the page while the model is still downloading.
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.getByRole("button", { name: "Try cleanup", exact: true })).toHaveCount(0);

  await finishDownload(electronApp);

  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("reasoningModel")))
    .toBe(localId);

  // Back on the page the model is the active one and can be tried.
  await page.getByRole("button", { name: "AI Enhancement", exact: true }).click();
  await expect(page.getByRole("button", { name: "Try cleanup", exact: true })).toBeEnabled();
});

test("a local AI model is not switched on after the user moved to an API provider", async ({
  controlPanel: page,
  electronApp,
}) => {
  await fakeSlowDownload(electronApp);
  await startLocalDownload(page, electronApp);

  await page.getByRole("combobox", { name: "Enhance using", exact: true }).click();
  await page.getByRole("option", { name: "API provider", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("reasoningProvider")))
    .not.toBe("qwen");

  await finishDownload(electronApp);
  // The download's own call has returned once the model is listed as downloaded.
  await expect
    .poll(() =>
      page.evaluate(() => window.electronAPI.modelGetAll().then((all) => all[0].isDownloaded))
    )
    .toBe(true);

  // Give the page a moment to act on the finished download, wrongly or not.
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => localStorage.getItem("reasoningModel"))).not.toBe(localId);
});
