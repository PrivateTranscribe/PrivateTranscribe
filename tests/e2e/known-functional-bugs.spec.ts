import { expect, test } from "./fixtures/electron-app";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

async function capture(page: Page, name: string) {
  const dir = process.env.PT_AUDIT_SHOTS;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  if (name === "download-active" || name === "download-returned") {
    await page.getByRole("button", { name: "Cancel", exact: true }).scrollIntoViewIfNeeded();
  }
  await page.screenshot({ path: path.join(dir, `${name}.png`), animations: "disabled" });
}

// Regression coverage for the functional review findings from 2026-09-10.
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
    expect(await visible()).toBe(false);
    await electronApp.evaluate(async ({ app }) => {
      app.emit("second-instance", {}, [process.execPath], process.cwd());
      await new Promise((resolve) => setImmediate(resolve));
    });
    expect(await visible()).toBe(true);
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
      let finish: (value: unknown) => void;
      ipcMain.handle(
        "download-whisper-model",
        (event, model) =>
          new Promise((resolve) => {
            finish = resolve;
            (globalThis as any).__auditProgress = () =>
              event.sender.send("whisper-download-progress", {
                type: "progress",
                model,
                percentage: 42,
                downloaded_bytes: 42,
                total_bytes: 100,
              });
          })
      );
      ipcMain.removeHandler("cancel-whisper-download");
      ipcMain.handle("cancel-whisper-download", () => {
        finish({ success: false, error: "Download interrupted by user" });
        return { success: true };
      });
    });
    await controlPanel.evaluate(() => localStorage.setItem("useLocalWhisper", "true"));
    await controlPanel.reload({ waitUntil: "domcontentloaded" });
    await controlPanel.getByRole("button", { name: "Dictation", exact: true }).click();
    await controlPanel.getByRole("button", { name: "Download", exact: true }).first().click();
    await expect(controlPanel.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
    await capture(controlPanel, "download-active");
    await controlPanel.getByRole("button", { name: "Home", exact: true }).click();
    await electronApp.evaluate(() => (globalThis as any).__auditProgress());
    await controlPanel.getByRole("button", { name: "Dictation", exact: true }).click();
    await expect(
      controlPanel.getByRole("button", { name: "Download", exact: true }).first()
    ).toBeVisible();
    await expect(controlPanel.getByText("42%", { exact: true })).toBeVisible();
    await capture(controlPanel, "download-returned");
    await expect(controlPanel.getByRole("button", { name: "Cancel", exact: true })).toBeVisible({
      timeout: 1500,
    });
    await controlPanel.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(controlPanel.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
    await expect(controlPanel.getByText("Download Failed", { exact: true })).toHaveCount(0);
    await capture(controlPanel, "download-cancelled");
  });

  test("does not select a cancelled download when success arrives late", async ({
    electronApp,
    controlPanel,
  }) => {
    await electronApp.evaluate(({ ipcMain }) => {
      let finish: (value: unknown) => void;
      let downloaded = false;
      ipcMain.removeHandler("list-whisper-models");
      ipcMain.handle("list-whisper-models", () => ({
        success: true,
        models: [{ model: "turbo", downloaded }],
      }));
      ipcMain.removeHandler("download-whisper-model");
      ipcMain.handle(
        "download-whisper-model",
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      );
      ipcMain.removeHandler("cancel-whisper-download");
      ipcMain.handle("cancel-whisper-download", () => {
        setTimeout(() => {
          downloaded = true;
          finish({ success: true });
        }, 300);
        return { success: true };
      });
    });
    await controlPanel.evaluate(() => localStorage.setItem("useLocalWhisper", "true"));
    await controlPanel.reload({ waitUntil: "domcontentloaded" });
    await controlPanel.getByRole("button", { name: "Dictation", exact: true }).click();
    const selected = await controlPanel.evaluate(() => localStorage.getItem("whisperModel"));
    await controlPanel.getByRole("button", { name: "Download", exact: true }).first().click();
    await controlPanel.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(controlPanel.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
    await expect(controlPanel.getByRole("button", { name: "...", exact: true })).toHaveCount(0);
    expect(await controlPanel.evaluate(() => localStorage.getItem("whisperModel"))).toBe(selected);
    await expect(controlPanel.getByText("Download Failed", { exact: true })).toHaveCount(0);
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
    await capture(controlPanel, "download-error");
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
