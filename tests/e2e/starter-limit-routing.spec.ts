import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";

/**
 * Hitting the Starter word limit must land the user on the Pro tab.
 *
 * The at-limit block is the one moment the app itself says "buy Pro". It used
 * to open the control panel on whatever tab was last left open, so the message
 * pointed at Pro while the window showed History or a settings page from last
 * week. The block now routes to Settings → Pro explicitly.
 *
 * No audio or model is involved: the limit check runs before recording starts.
 */

const EVIDENCE_DIR = path.resolve(__dirname, "..", "..", "docs", "goal-evidence");
const MIN_SCREENSHOT_BYTES = 1_000;

async function captureEvidence(page: Page, fileName: string) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const filePath = path.join(EVIDENCE_DIR, fileName);
  await page.screenshot({ path: filePath, fullPage: true });

  const bytes = fs.statSync(filePath).size;
  expect(bytes, `${fileName} is too small to show anything (${bytes} bytes)`).toBeGreaterThan(
    MIN_SCREENSHOT_BYTES
  );
}

test("the at-limit block opens Settings on the Pro tab", async ({
  electronApp,
  overlayWindow,
  controlPanel,
}) => {
  // A Starter user who has spent today's words, written the way the app
  // writes it (see src/utils/starterUsage.js).
  await overlayWindow.evaluate(() => {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate()
    ).padStart(2, "0")}`;
    localStorage.setItem(
      "privatetranscribe_starter_usage_v1",
      JSON.stringify({ date: today, wordsUsed: 5000, limit: 5000 })
    );
    localStorage.setItem("audioFeedback", "false");
  });
  await overlayWindow.reload({ waitUntil: "domcontentloaded" });
  await expect(overlayWindow.getByRole("button", { name: "Dictation overlay" })).toBeVisible();

  // Leave the panel on a page that is NOT settings, so the assertion below
  // can only pass if the block actually navigated.
  await controlPanel.getByRole("button", { name: "History" }).click();

  await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(
      (w) => !w.isDestroyed() && !w.webContents.getURL().includes("panel=true")
    );
    if (!win) throw new Error("no dictation overlay window to toggle");
    win.webContents.send("toggle-dictation");
  });

  await expect(overlayWindow.getByText("Starter word limit reached")).toBeVisible({
    timeout: 15_000,
  });
  await captureEvidence(overlayWindow, "starter-limit-toast.png");

  // The panel landed on Settings → Pro: the upgrade section is on screen.
  await expect(
    controlPanel.getByText("PrivateTranscribe Pro", { exact: false }).first()
  ).toBeVisible({ timeout: 15_000 });
  await captureEvidence(controlPanel, "starter-limit-pro-tab.png");
});
