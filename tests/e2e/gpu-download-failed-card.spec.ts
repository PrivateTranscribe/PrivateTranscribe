import fs from "node:fs";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";
import { evidenceDir } from "./fixtures/evidence";

/**
 * A GPU engine card follows the broadcast download progress, also for a
 * download it did not start (the silent startup update). A failed download
 * sent no last event, so the card said "Downloading" until Settings was
 * closed. The download manager now ends with a "failed" event (unit-tested in
 * gpuBinaryManagerConcurrentDownload.test.ts); this sends those events the way
 * main broadcasts them and checks what the General tab card shows.
 *
 * No download runs: the engine status is stubbed as "supported, not
 * installed", so the card looks the same on any PC.
 */

async function broadcast(app: ElectronApplication, progress: Record<string, unknown>) {
  await app.evaluate(({ BrowserWindow }, p) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("cuda-binary-download-progress", p);
    }
  }, progress);
}

async function openGpuCard(page: Page) {
  await page.evaluate(() =>
    (window as any).electronAPI.openControlPanel({ page: "settings", settingsTab: "general" })
  );
  const card = page.getByText("GPU engine", { exact: true }).first();
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeVisible();
}

test("a download that fails in the background ends on the card with its error", async ({
  electronApp,
  controlPanel,
}) => {
  const shots = evidenceDir("gpu-download-failed-card");
  fs.mkdirSync(shots, { recursive: true });

  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("get-cuda-binary-status");
    ipcMain.handle("get-cuda-binary-status", () => ({
      supported: true,
      installed: false,
      upToDate: false,
      version: null,
      expectedVersion: "1.8.4",
      activeDownload: null,
    }));
  });
  await openGpuCard(controlPanel);

  // The startup update runs; this card did not start it.
  await broadcast(electronApp, { phase: "downloading", percent: 37, totalBytes: 750_000_000 });
  await expect(controlPanel.getByText("Downloading", { exact: true })).toBeVisible();

  await broadcast(electronApp, { phase: "failed", percent: 0, error: "HTTP 503 from the server" });

  await expect(controlPanel.getByText("HTTP 503 from the server")).toBeVisible();
  await expect(controlPanel.getByText("Downloading", { exact: true })).toHaveCount(0);
  await expect(controlPanel.getByText("Not installed", { exact: true })).toBeVisible();
  await controlPanel.screenshot({ path: path.join(shots, "after-failed.png") });
});

test("a download cancelled elsewhere puts the card back", async ({ electronApp, controlPanel }) => {
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("get-cuda-binary-status");
    ipcMain.handle("get-cuda-binary-status", () => ({
      supported: true,
      installed: false,
      upToDate: false,
      version: null,
      expectedVersion: "1.8.4",
      activeDownload: null,
    }));
  });
  await openGpuCard(controlPanel);

  await broadcast(electronApp, { phase: "downloading", percent: 12 });
  await expect(controlPanel.getByText("Downloading", { exact: true })).toBeVisible();
  await broadcast(electronApp, { phase: "cancelled", percent: 0, error: null });

  await expect(controlPanel.getByText("Downloading", { exact: true })).toHaveCount(0);
  await expect(controlPanel.getByText("Not installed", { exact: true })).toBeVisible();
});
